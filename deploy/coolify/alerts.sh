#!/bin/sh
# Alerts for the Cresslet host (docs/self-hosting.md#alerts): disk, memory, the firewall failing
# closed (deploy/coolify/firewall.sh stopped Cresslet), and a failed backup run.
#
#   alerts.sh <network>            check once
#   alerts.sh <network> --install  copy to /usr/local/sbin, check every minute (systemd timer)
#   alerts.sh <network> --test     send a test alert
#
# <network>: the compose app's Docker network, as for firewall.sh. Needs root.
# Each alert goes to the journal (journalctl -t cresslet-alert) and, with CRESSLET_ALERT_URL set, is
# POSTed there: as plain text (ntfy), or as JSON {"<key>": "<text>"} with CRESSLET_ALERT_JSON_KEY
# (`content` for a Discord webhook, `text` for Slack). One alert when a check starts failing, one
# when it recovers; a send that fails is retried at the next check.
#   CRESSLET_ALERT_DISK_PCT  (80)  a filesystem holding CRESSLET_ALERT_PATHS is this full
#   CRESSLET_ALERT_MEM_PCT   (90)  the host's memory in use (from MemAvailable), or a Cresslet
#                                  container's of its memory limit; and any container restart
#   CRESSLET_ALERT_PATHS     (/var/lib/docker /var/backups/cresslet)
# --install writes them, with CRESSLET_ALERT_URL, to /etc/cresslet-alerts.env (0600): rerun with them all.
set -eu
NET=${1:?usage: alerts.sh <docker network> [--install|--test]}
MODE=${2:-check}
CONF=${CRESSLET_ALERT_CONF:-/etc/cresslet-alerts.env}
STATE=${CRESSLET_ALERT_STATE:-/var/lib/cresslet-alerts}
FW=${CRESSLET_FIREWALL_STATE:-/var/lib/cresslet-firewall}/$NET.stopped
MEMINFO=${CRESSLET_ALERT_MEMINFO:-/proc/meminfo}

if [ "$MODE" = --install ]; then
  docker network inspect "$NET" >/dev/null
  install -m 0755 "$0" /usr/local/sbin/cresslet-alerts
  q() { printf "%s='%s'\n" "$1" "$(printf %s "$2" | sed "s/'/'\\\\''/g")"; }
  (umask 077
   { q CRESSLET_ALERT_URL "${CRESSLET_ALERT_URL:-}"; q CRESSLET_ALERT_JSON_KEY "${CRESSLET_ALERT_JSON_KEY:-}"
     q CRESSLET_ALERT_DISK_PCT "${CRESSLET_ALERT_DISK_PCT:-80}"; q CRESSLET_ALERT_MEM_PCT "${CRESSLET_ALERT_MEM_PCT:-90}"
     q CRESSLET_ALERT_PATHS "${CRESSLET_ALERT_PATHS:-/var/lib/docker /var/backups/cresslet}"; } > "$CONF.new"
   mv "$CONF.new" "$CONF")
  [ -n "${CRESSLET_ALERT_URL:-}" ] || echo "cresslet-alerts: CRESSLET_ALERT_URL unset: alerts only go to the journal" >&2
  cat > /etc/systemd/system/cresslet-alerts.service <<EOF
[Unit]
Description=Cresslet host alerts ($NET)
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cresslet-alerts $NET
EOF
  cat > /etc/systemd/system/cresslet-alerts.timer <<EOF
[Unit]
Description=Check the Cresslet host every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now cresslet-alerts.timer
  exit 0
fi

# Root's own file (written above), so sourcing it runs nothing it didn't write.
[ ! -r "$CONF" ] || . "$CONF"
URL=${CRESSLET_ALERT_URL:-} KEY=${CRESSLET_ALERT_JSON_KEY:-}
DISK=${CRESSLET_ALERT_DISK_PCT:-80} MEM=${CRESSLET_ALERT_MEM_PCT:-90}
PATHS=${CRESSLET_ALERT_PATHS:-/var/lib/docker /var/backups/cresslet}
HOST=$(hostname 2>/dev/null || uname -n)
rc=0

send() {
  msg="cresslet on $HOST: $1"
  logger -t cresslet-alert -- "$msg" 2>/dev/null || echo "$msg" >&2
  [ -n "$URL" ] || return 0
  if [ -n "$KEY" ]; then
    body="{\"$KEY\":\"$(printf %s "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')\"}" type=application/json
  else
    body=$msg type=text/plain
  fi
  # The URL goes in on stdin, not argv (ps shows argv; a webhook URL is a secret).
  printf 'url = "%s"\n' "$(printf %s "$URL" | sed 's/\\/\\\\/g; s/"/\\"/g')" | curl -fsS -m 20 -K - -H "content-type: $type" --data-binary "$body" -o /dev/null && return 0
  echo "cresslet-alerts: couldn't send the alert to CRESSLET_ALERT_URL" >&2
  rc=1
  return 1
}

if [ "$MODE" = --test ]; then
  send "test alert (cresslet-alerts works)"
  exit $rc
fi

mkdir -p "$STATE"
# report <check> <problem>: alert when <problem> appears (non-empty), and again when it's gone.
report() {
  f=$STATE/$1
  if [ -n "$2" ]; then
    [ -f "$f" ] || { send "$2" && printf '%s\n' "$2" > "$f"; } || :
  elif [ -f "$f" ]; then
    { send "recovered: $(cat "$f")" && rm -f "$f"; } || :
  fi
}
failed() { systemctl is-failed --quiet "$1" 2>/dev/null; }

# Disk: each filesystem once.
p="" seen=" "
for d in $PATHS; do
  [ -e "$d" ] || continue
  set -- $(df -P "$d" | awk 'NR == 2 { sub("%", "", $5); print $6, $5 }')
  case $seen in *" $1 "*) continue ;; esac
  seen="$seen$1 "
  [ "$2" -lt "$DISK" ] || p="${p:+$p; }disk $2% full on $1"
done
report disk "$p"

# Memory: the host, and the Cresslet containers (on its network, not Coolify's proxy) of their limits.
p=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 }
  END { u = int((t - a) * 100 / t); if (u >= m) print "host memory " u "% in use" }' m="$MEM" "$MEMINFO")
running=""
for c in $(docker ps --filter "network=$NET" --format '{{.ID}}' 2>/dev/null); do
  set -- $(docker inspect -f '{{.Name}} {{or (index .Config.Labels "coolify.proxy") "-"}} {{.RestartCount}} {{.State.OOMKilled}}' "$c")
  [ "$2" != true ] || continue
  running="$running $c"
  name=${1#/} restarts=$3 oom=$4
  u=$(docker stats --no-stream --format '{{.MemPerc}}' "$c" | cut -d. -f1 | tr -dc 0-9)
  [ "${u:-0}" -lt "$MEM" ] || p="${p:+$p; }$name at $u% of its memory limit"
  # Restarts (an OOM kill, a crash): one alert per new restart. A redeploy is a new container.
  f=$STATE/restarts-$c
  [ "$restarts" -gt "$(cat "$f" 2>/dev/null || echo 0)" ] || continue
  send "$name restarted (restarts: $restarts, OOM-killed: $oom; docker logs $name)" && echo "$restarts" > "$f" || :
done
report memory "$p"
for f in "$STATE"/restarts-*; do
  [ -f "$f" ] || continue
  docker inspect "${f##*/restarts-}" >/dev/null 2>&1 || rm -f "$f"
done

# Firewall: failing, or failed closed (it stopped Cresslet, and nothing on the network was started
# since). Starting Cresslet again (Coolify: start or redeploy) clears it.
p=""
failed cresslet-firewall.service && p="cresslet-firewall can't apply its rules (journalctl -u cresslet-firewall)"
if [ -f "$FW" ]; then
  if [ -n "$running" ] && [ -z "$p" ]; then
    rm -f "$FW"
  else
    p="cresslet-firewall couldn't apply its rules and stopped Cresslet at $(cat "$FW") (journalctl -u cresslet-firewall); start it again once fixed"
  fi
fi
report firewall "$p"

p=""
failed cresslet-backup.service && p="the last backup failed (journalctl -u cresslet-backup)"
report backup "$p"

exit $rc
