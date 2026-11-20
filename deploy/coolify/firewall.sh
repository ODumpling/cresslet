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
# Needs root. Docker names a user-defined bridge br-<first 12 chars of the network id>.
set -eu
NET=${1:?usage: firewall.sh <docker network> [--remove|--install]}
MODE=${2:-apply}
FWD=CRESSLET-FWD IN=CRESSLET-IN
STATE=/var/lib/cresslet-firewall/$NET.bridge

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
  while "$1" -D "$2" -j "$3" 2>/dev/null; do :; done
  "$1" -F "$3" 2>/dev/null || true
  "$1" -X "$3" 2>/dev/null || true
}

if [ "$MODE" = --remove ]; then
  for t in iptables ip6tables; do unhook $t DOCKER-USER $FWD; unhook $t INPUT $IN; done
  rm -f "$STATE"
  exit 0
fi

if [ "$MODE" = --boot ]; then
  [ -f "$STATE" ] || exit 0
  BR=$(cat "$STATE")
else
  ID=$(docker network inspect "$NET" --format '{{.Id}}' 2>/dev/null) || { echo "cresslet-firewall: no network $NET" >&2; exit 1; }
  BR=br-$(echo "$ID" | cut -c1-12)
  mkdir -p "${STATE%/*}"
  [ "$(cat "$STATE" 2>/dev/null)" = "$BR" ] || echo "$BR" > "$STATE"
fi

# swap <cmd> <parent> <chain> <rule args>...: build <chain>.n, jump to it from the top of <parent>,
# drop the old chain, rename. The parent always jumps to a complete chain, so there's no gap.
swap() {
  t=$1 parent=$2 c=$3; shift 3
  n=$c.n
  # Before Docker (at boot) DOCKER-USER may not exist yet; Docker keeps one it finds.
  [ "$parent" = INPUT ] || "$t" -N "$parent" 2>/dev/null || true
  unhook "$t" "$parent" "$n"
  "$t" -N "$n"
  for r in "$@"; do eval "\"\$t\" -A \"\$n\" $r"; done
  "$t" -I "$parent" 1 -j "$n"
  unhook "$t" "$parent" "$c"
  "$t" -E "$n" "$c"
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
