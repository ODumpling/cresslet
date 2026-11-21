#!/bin/sh
# Keeps Cresslet's Docker network off the host and off private networks (other containers, the LAN,
# Tailscale, cloud metadata), whatever its subnet. Public internet and replies stay allowed.
#
#   firewall.sh <network>            apply (idempotent; safe to run every minute)
#   firewall.sh <network> --remove   take the rules out
#   firewall.sh <network> --install  copy to /usr/local/sbin, re-apply every minute (systemd timer),
#                                    and at boot before Docker starts containers
#   firewall.sh <network> --boot     apply to the bridge saved by the last run (no Docker needed)
#
# <network>: the container's Docker network (a Coolify compose app's network is its application UUID).
# One network per host: the chains (CRESSLET-FWD, CRESSLET-IN) have fixed names.
# Needs root. Docker names a user-defined bridge br-<first 12 chars of the network id>.
# Every iptables call waits for the xtables lock (-w): Docker and ufw take it too, at boot especially.
# When it fails closed it leaves <state dir>/<network>.stopped for deploy/coolify/alerts.sh.
set -eu
NET=${1:?usage: firewall.sh <docker network> [--remove|--install]}
MODE=${2:-apply}
FWD=CRESSLET-FWD IN=CRESSLET-IN
DIR=${CRESSLET_FIREWALL_STATE:-/var/lib/cresslet-firewall}
STATE=$DIR/$NET.bridge

if [ "$MODE" = --install ]; then
  install -m 0755 "$0" /usr/local/sbin/cresslet-firewall
  cat > /etc/systemd/system/cresslet-firewall.service <<EOF
[Unit]
Description=Cresslet container network isolation ($NET)
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cresslet-firewall $NET
EOF
  # At boot Docker restarts containers as soon as it's up: load the rules first (after ufw, whose
  # docker rules re-create DOCKER-USER). A network Coolify creates later is covered within a minute.
  cat > /etc/systemd/system/cresslet-firewall-boot.service <<EOF
[Unit]
Description=Cresslet container network isolation at boot ($NET)
After=ufw.service
Before=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/cresslet-firewall $NET --boot
[Install]
WantedBy=docker.service
EOF
  cat > /etc/systemd/system/cresslet-firewall.timer <<EOF
[Unit]
Description=Re-apply Cresslet network isolation (the bridge changes if the network is recreated)
[Timer]
OnBootSec=20s
OnUnitActiveSec=1min
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now cresslet-firewall.timer
  systemctl enable cresslet-firewall-boot.service
  systemctl start cresslet-firewall.service
  exit 0
fi

# unhook <cmd> <parent> <chain>: remove every jump to <chain> from <parent>, then the chain itself.
unhook() {
  while "$1" -w -D "$2" -j "$3" 2>/dev/null; do :; done
  "$1" -w -F "$3" 2>/dev/null || true
  "$1" -w -X "$3" 2>/dev/null || true
}

if [ "$MODE" = --remove ]; then
  for t in iptables ip6tables; do
    for c in $FWD $FWD.n; do unhook $t DOCKER-USER $c; done
    for c in $IN $IN.n; do unhook $t INPUT $c; done
  done
  rm -f "$STATE" "$DIR/$NET.stopped"
  exit 0
fi

stop_all() {
  echo "cresslet-firewall: couldn't apply the rules for $NET; stopping its containers" >&2
  docker ps --filter "network=$NET" --format '{{.ID}} {{.Label "coolify.proxy"}}' | {
    stopped="" failed=""
    while read -r c proxy; do
      [ "$proxy" != true ] || continue
      if docker stop "$c" >/dev/null; then stopped="$stopped $c"; else failed="$failed $c"; fi
    done
    [ -z "$failed" ] || echo "cresslet-firewall: couldn't stop:$failed" >&2
    # For alerts.sh, after the stops: "<time> stopped" (the first time, kept while it stays
    # stopped) or "<time> couldn't stop: <ids>". Nothing to stop: no marker.
    f=$DIR/$NET.stopped now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    mkdir -p "$DIR" || exit 0
    if [ -n "$failed" ]; then
      echo "$now couldn't stop:$failed" > "$f"
    elif [ -n "$stopped" ] && ! grep -q ' stopped$' "$f" 2>/dev/null; then
      echo "$now stopped" > "$f"
    fi
  } || true
}

if [ "$MODE" = --boot ]; then
  [ -f "$STATE" ] || exit 0
  BR=$(cat "$STATE")
else
  ID=$(docker network inspect "$NET" --format '{{.Id}}' 2>/dev/null) || { echo "cresslet-firewall: no network $NET" >&2; exit 1; }
  BR=br-$(echo "$ID" | cut -c1-12)
  # Fail closed: if the rules can't be put in place, stop what runs on that network (not Coolify's
  # proxy, which is attached to it too) rather than leave it unfirewalled. Start it again by hand.
  trap 'rc=$?; [ $rc -eq 0 ] || stop_all; exit $rc' EXIT
  mkdir -p "${STATE%/*}"
  [ "$(cat "$STATE" 2>/dev/null)" = "$BR" ] || echo "$BR" > "$STATE"
fi

# swap <cmd> <parent> <chain> <rule args>...: build <chain>.n, jump to it from the top of <parent>,
# drop the old chain, rename. The parent always jumps to a complete chain, so there's no gap.
swap() {
  t=$1 parent=$2 c=$3; shift 3
  n=$c.n
  # Before Docker (at boot) DOCKER-USER may not exist yet; Docker keeps one it finds.
  [ "$parent" = INPUT ] || "$t" -w -N "$parent" 2>/dev/null || true
  unhook "$t" "$parent" "$n"
  "$t" -w -N "$n"
  for r in "$@"; do eval "\"\$t\" -w -A \"\$n\" $r"; done
  "$t" -w -I "$parent" 1 -j "$n"
  unhook "$t" "$parent" "$c"
  "$t" -w -E "$n" "$c"
}

for t in iptables ip6tables; do
  if [ $t = iptables ]; then
    PRIV="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16"
  else
    PRIV="fc00::/7 fe80::/10"
  fi
  set -- "-i $BR -o $BR -j RETURN" "-i $BR -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  for p in $PRIV; do set -- "$@" "-i $BR -d $p -j DROP"; done
  # Forwarded: same network (Traefik) and replies pass; new connections to private ranges don't.
  swap $t DOCKER-USER $FWD "$@"
  # To the host itself (its SSH, Coolify on :8000, …): replies only.
  swap $t INPUT $IN "-i $BR -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN" "-i $BR -j DROP"
done

# The rules apply: a marker from failing closed goes once Cresslet runs again (one it couldn't stop
# goes now). Here, not in alerts.sh: runs don't overlap, so no stop can come between the check and
# the removal. A failing `docker ps` keeps it (and doesn't fail the run).
M=$DIR/$NET.stopped
if [ "$MODE" != --boot ] && [ -f "$M" ]; then
  if ! grep -q ' stopped$' "$M" ||
    docker ps --filter "network=$NET" --format '{{.ID}} {{.Label "coolify.proxy"}}' | awk '$2 != "true" { f = 1 } END { exit !f }'; then
    rm -f "$M"
  fi
fi
