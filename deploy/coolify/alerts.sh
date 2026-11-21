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
# when it recovers; one the URL refuses is queued and sent after the checks of a later run.
#   CRESSLET_ALERT_DISK_PCT  (80)  a filesystem holding CRESSLET_ALERT_PATHS is this full
#   CRESSLET_ALERT_MEM_PCT   (90)  the host's memory in use (from MemAvailable), or a Cresslet
#                                  container's of its memory limit
# Restarts of a Cresslet container alert whatever the thresholds.
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
# A hung run would hold every later check (the timer doesn't start a unit still running).
TimeoutStartSec=50s
ExecStart=/usr/local/sbin/cresslet-alerts $NET
EOF
  cat > /etc/systemd/system/cresslet-alerts.timer <<EOF
[Unit]
Description=Check the Cresslet host every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s
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
OUTBOX=$STATE/outbox
rc=0

# post <text>: to CRESSLET_ALERT_URL (nothing to do without one).
post() {
  [ -n "$URL" ] || return 0
  if [ -n "$KEY" ]; then
    body="{\"$KEY\":\"$(printf %s "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')\"}" type=application/json
  else
    body=$1 type=text/plain
  fi
  # The URL goes in on stdin, not argv (ps shows argv; a webhook URL is a secret).
  printf 'url = "%s"\n' "$(printf %s "$URL" | sed 's/\\/\\\\/g; s/"/\\"/g')" |
    curl -fsS -m 20 -K - -H "content-type: $type" --data-binary "$body" -o /dev/null && return 0
  echo "cresslet-alerts: couldn't send the alert to CRESSLET_ALERT_URL" >&2
  rc=1
  return 1
}

if [ "$MODE" = --test ]; then
  post "cresslet on $HOST: test alert (cresslet-alerts works)"
  exit $rc
fi

mkdir -p "$STATE"
# send <text>: to the journal now, and to the URL now, or (queued, with the time) at the end of
# this or a later check, after anything queued before it.
send() {
  logger -t cresslet-alert -- "cresslet on $HOST: $1" 2>/dev/null || echo "cresslet on $HOST: $1" >&2
  [ ! -s "$OUTBOX" ] && post "cresslet on $HOST: $1" ||
    printf '%s\n' "cresslet on $HOST: $1 (at $(date -u +%Y-%m-%dT%H:%M:%SZ))" >> "$OUTBOX"
}
# report <check> <problem>: alert when <problem> appears (non-empty), and again when it's gone.
report() {
  f=$STATE/$1
  if [ -n "$2" ]; then
    # A full disk can refuse the write: the alert went, the rest of the checks still run.
    [ -f "$f" ] || { send "$2"; printf '%s\n' "$2" > "$f" || :; }
  elif [ -f "$f" ]; then
    send "recovered: $(cat "$f")"
    rm -f "$f"
  fi
}
failed() { systemctl is-failed --quiet "$1" 2>/dev/null; }
# unit_bad <unit> <check>: it failed, or <check> is firing and the next run hasn't finished yet
# (a unit that runs again is "activating", no longer "failed": that isn't a recovery yet).
unit_bad() { failed "$1" || { [ -f "$STATE/$2" ] && [ "$(systemctl is-active "$1" 2>/dev/null)" = activating ]; }; }
# Docker calls are bounded: a hung dockerd (likely when the disk or memory runs out) mustn't stall
# the checks. Those that don't need Docker go first.
if command -v timeout >/dev/null; then dk() { timeout 15 docker "$@"; }; else dk() { docker "$@"; }; fi
# limit <check> <threshold>: 5 points lower while <check> is firing, so a value hovering at the
# threshold doesn't alert and recover over and over.
limit() { if [ -f "$STATE/$1" ]; then echo $(($2 - 5)); else echo "$2"; fi; }
# A probe that fails sets err: the check then doesn't recover this time (a failed df isn't a disk
# with room).
err=""

# Disk: each filesystem once.
p="" seen=" " lim=$(limit disk "$DISK")
for d in $PATHS; do
  [ -e "$d" ] || continue
  set -- $(df -P "$d" 2>/dev/null | awk 'NR == 2 { sub("%", "", $5); print $6, $5 }')
  [ $# -eq 2 ] || { echo "cresslet-alerts: df couldn't read $d" >&2; err=1; continue; }
  case $seen in *" $1 "*) continue ;; esac
  seen="$seen$1 "
  [ "$2" -lt "$lim" ] || p="${p:+$p; }disk $2% full on $1"
done
[ -n "$p" ] || [ -z "$err" ] || [ ! -f "$STATE/disk" ] || p=$(cat "$STATE/disk")
report disk "$p"

# Firewall: failed closed (firewall.sh's marker; it removes it itself once its rules apply and
# Cresslet runs again), and failing. One check per outcome, so a change is a new alert.
stopped="" unstopped=""
if [ -f "$FW" ]; then
  m=$(cat "$FW")
  case $m in
    *" stopped") stopped="cresslet-firewall couldn't apply its rules and stopped Cresslet at ${m%% *}; start it again once fixed" ;;
    *) unstopped="cresslet-firewall couldn't apply its rules or stop${m##*:} at ${m%% *}: they run unfirewalled" ;;
  esac
fi
report firewall-stop "${stopped:+$stopped (journalctl -u cresslet-firewall)}"
report firewall-unstopped "${unstopped:+$unstopped (journalctl -u cresslet-firewall)}"
p=""
unit_bad cresslet-firewall.service firewall && p="cresslet-firewall can't apply its rules (journalctl -u cresslet-firewall)"
report firewall "$p"

p=""
unit_bad cresslet-backup.service backup && p="the last backup failed (journalctl -u cresslet-backup)"
report backup "$p"

# The Cresslet containers: running on the network, not Coolify's proxy. Sets out to "<id> <fields>"
# lines (fields: an inspect template).
err=""
ids=$(dk ps --filter "network=$NET" --format '{{.ID}}') || { echo "cresslet-alerts: docker ps failed" >&2; err=1; }
cresslet() {
  out=""
  for c in $ids; do
    if i=$(dk inspect -f "{{or (index .Config.Labels \"coolify.proxy\") \"-\"}} $1" "$c"); then
      [ "${i%% *}" = true ] || out="$out$c ${i#* }
"
    else
      err=1 # gone since `docker ps` (a redeploy), or Docker failing: no conclusion this time
    fi
  done
}

# Memory: the host, and each Cresslet container of its limit.
lim=$(limit memory "$MEM")
p=$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 }
  END { u = int((t - a) * 100 / t); if (u >= m) print "host memory " u "% in use" }' m="$lim" "$MEMINFO")
cresslet '{{.Name}}'
for c in $(printf %s "$out" | cut -d' ' -f1); do
  u=$(dk stats --no-stream --format '{{.Name}} {{.MemPerc}}' "$c") || { err=1; continue; }
  pct=$(echo "${u#* }" | cut -d. -f1 | tr -dc 0-9)
  [ "${pct:-0}" -lt "$lim" ] || p="${p:+$p; }${u%% *} at $pct% of its memory limit"
done
[ -n "$p" ] || [ -z "$err" ] || [ ! -f "$STATE/memory" ] || p=$(cat "$STATE/memory")
report memory "$p"

# Restarts (an OOM kill, a crash): an alert when the count goes up (two in a minute: one alert).
# A redeploy is a new container.
cresslet '{{.Name}} {{.RestartCount}} {{.State.OOMKilled}}'
while read -r c name n oom; do
  f=$STATE/restarts-$c
  old=$(cat "$f" 2>/dev/null || :)
  case $old in '' | *[!0-9]*) old=0 ;; esac # none yet, or cut short by a killed run
  [ -n "$oom" ] && [ "$n" -gt "$old" ] || continue
  send "${name#/} restarted (restarts: $n, last exit OOM-killed: $oom; docker logs ${name#/})"
  echo "$n" > "$f" || :
done <<EOF
$out
EOF
for f in "$STATE"/restarts-*; do
  [ -f "$f" ] && [ -z "$err" ] || continue # Docker failing (each call can take 15 s): another time
  # Only once Docker says it's gone (not when the call fails or times out).
  ! dk inspect "${f##*/restarts-}" 2>&1 >/dev/null | grep -qi "no such" || rm -f "$f"
done

# Last, so slow deliveries never hold up the checks: queued alerts, oldest first, each removed once
# sent (a run killed mid-way sends at most one twice), up to the first that fails again. Not after
# a send that already failed this time.
while [ "$rc" -eq 0 ] && [ -s "$OUTBOX" ]; do
  IFS= read -r m < "$OUTBOX" || break
  post "$m" || break
  sed 1d "$OUTBOX" > "$OUTBOX.n" && mv "$OUTBOX.n" "$OUTBOX" || break # disk full: not the same line again
done

exit $rc
