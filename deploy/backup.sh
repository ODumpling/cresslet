#!/bin/sh
# Snapshots a Cresslet data volume: every SQLite database through `.backup` (consistent while the
# server runs), everything else (secrets.key, deploys, app files) copied, as one .tgz. Keeps the
# newest $CRESSLET_BACKUP_KEEP (14) and, if $CRESSLET_BACKUP_RCLONE is set (an rclone remote such as
# `r2:bucket/cresslet`, configured for root), copies each new snapshot there too.
#
#   backup.sh <volume>             one snapshot now
#   backup.sh <volume> --install   copy to /usr/local/sbin, snapshot daily (systemd timer)
#
# Snapshots hold secrets.key: they're root-only (0600 in a 0700 dir). Restore: docs/self-hosting.md#backups.
set -eu
VOL=${1:?usage: backup.sh <docker volume> [--install]}
DIR=${CRESSLET_BACKUP_DIR:-/var/backups/cresslet}
KEEP=${CRESSLET_BACKUP_KEEP:-14}
REMOTE=${CRESSLET_BACKUP_RCLONE:-}

if [ "${2:-}" = --install ]; then
  install -m 0755 "$0" /usr/local/sbin/cresslet-backup
  cat > /etc/systemd/system/cresslet-backup.service <<EOF
[Unit]
Description=Snapshot the Cresslet data volume ($VOL)
After=docker.service
[Service]
Type=oneshot
Environment=CRESSLET_BACKUP_DIR=$DIR CRESSLET_BACKUP_KEEP=$KEEP CRESSLET_BACKUP_RCLONE=$REMOTE
ExecStart=/usr/local/sbin/cresslet-backup $VOL
EOF
  cat > /etc/systemd/system/cresslet-backup.timer <<EOF
[Unit]
Description=Daily Cresslet snapshot
[Timer]
OnCalendar=*-*-* 03:30
RandomizedDelaySec=30min
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now cresslet-backup.timer
  exit 0
fi

docker volume inspect "$VOL" >/dev/null
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
NAME=cresslet-$(date -u +%Y%m%dT%H%M%SZ).tgz
# Read-write mount: SQLite needs the -shm file of a WAL database even to read it.
docker run --rm -v "$VOL":/data -v "$DIR":/out alpine:3.24 sh -ec '
  apk add -q --no-cache sqlite tar >/dev/null
  mkdir /s
  cd /data
  # Everything except the databases and their sidecars (snapshotted below). A file changing or
  # vanishing mid-copy is tar status 1 (allowed: the server is running); anything worse fails.
  ex=""
  for db in ./cresslet.db "./apps/*/data/db.sqlite" "./apps/*/data/files/index.sqlite"; do
    for x in "" -wal -shm -journal; do ex="$ex --exclude=$db$x"; done
  done
  set -f  # $ex holds patterns for tar, not the shell
  { tar -cf - --anchored --no-wildcards-match-slash \
      --warning=no-file-changed --warning=no-file-removed --warning=no-file-shrank $ex . || rc=$?; echo "${rc:-0}" > /tmp/rc; } |
    tar -xpf - -C /s
  set +f
  [ "$(cat /tmp/rc)" -le 1 ] || { echo "copying the volume failed (tar status $(cat /tmp/rc))" >&2; exit 1; }
  # The databases (not app-stored files, whatever they are named), each a consistent copy with the
  # original owner and mode (the server may run as a non-root user).
  for db in cresslet.db apps/*/data/db.sqlite apps/*/data/files/index.sqlite; do
    [ -f "$db" ] || continue
    # An app that set up its files after the copy: its dirs (top down), with their owners and modes.
    set --; d=$(dirname "$db")
    while [ "$d" != . ]; do set -- "$d" "$@"; d=$(dirname "$d"); done
    for d in "$@"; do
      [ -d "/s/$d" ] || { mkdir "/s/$d"; chown "$(stat -c %u:%g "$d")" "/s/$d"; chmod "$(stat -c %a "$d")" "/s/$d"; }
    done
    sqlite3 "$db" ".backup /s/$db"
    chown "$(stat -c %u:%g "$db")" "/s/$db"
    chmod "$(stat -c %a "$db")" "/s/$db"
    [ "$(sqlite3 "/s/$db" "PRAGMA integrity_check")" = ok ] || { echo "integrity check failed: $db" >&2; exit 1; }
  done
  tar czf "/out/'"$NAME"'.part" -C /s .
  mv "/out/'"$NAME"'.part" "/out/'"$NAME"'"'
chmod 600 "$DIR/$NAME"
echo "cresslet-backup: $DIR/$NAME ($(du -h "$DIR/$NAME" | cut -f1))"

# Newest $KEEP stay.
ls -1t "$DIR"/cresslet-*.tgz | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done

if [ -n "$REMOTE" ]; then
  rclone copyto "$DIR/$NAME" "$REMOTE/$NAME"
  echo "cresslet-backup: copied to $REMOTE/$NAME"
fi
