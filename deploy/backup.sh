#!/bin/sh
# Snapshots a Cresslet data volume: every SQLite database through `.backup` (consistent while the
# server runs), everything else (deploys, app files) copied, as one .tgz. secrets.key is kept apart,
# as $DIR/secrets-<fingerprint>.key; a snapshot's name ends with the fingerprint of the key it needs.
# Keeps the newest $CRESSLET_BACKUP_KEEP (14) snapshots, and every key. Off-site (rclone remotes
# configured for root, `name:path`, e.g. S3-compatible storage):
#   CRESSLET_BACKUP_RCLONE      each new snapshot is copied there (e.g. `snaps:cresslet-snapshots`)
#   CRESSLET_BACKUP_KEY_RCLONE  the keys are copied there, never overwritten: another rclone remote
#                               (another bucket, other credentials), so one leak doesn't hold both.
#
#   backup.sh <volume>             one snapshot now
#   backup.sh <volume> --install   copy to /usr/local/sbin, snapshot daily (systemd timer)
#
# Root-only (0600 in a 0700 dir). Restore: docs/self-hosting.md#backups.
set -eu
VOL=${1:?usage: backup.sh <docker volume> [--install]}
DIR=${CRESSLET_BACKUP_DIR:-/var/backups/cresslet}
KEEP=${CRESSLET_BACKUP_KEEP:-14}
REMOTE=${CRESSLET_BACKUP_RCLONE:-}
KEY_REMOTE=${CRESSLET_BACKUP_KEY_RCLONE:-}
for r in "$REMOTE" "$KEY_REMOTE"; do
  [ -n "$r" ] || continue
  # name:path, name a configured remote exactly (not a local path, not `name,option:`).
  case $r in *:*) rclone listremotes | grep -qxF "${r%%:*}:" && continue ;; esac
  echo "cresslet-backup: $r isn't name:path with a remote from \`rclone listremotes\`" >&2
  exit 1
done
if [ -n "$REMOTE" ] && [ "${KEY_REMOTE%%:*}" = "${REMOTE%%:*}" ]; then
  echo "cresslet-backup: CRESSLET_BACKUP_KEY_RCLONE needs its own rclone remote (other credentials), not ${REMOTE%%:*}:" >&2
  exit 1
fi

if [ "${2:-}" = --install ]; then
  [ -z "$REMOTE" ] || [ -n "$KEY_REMOTE" ] ||
    echo "cresslet-backup: CRESSLET_BACKUP_KEY_RCLONE unset: runs will fail while the volume has a secrets.key" >&2
  install -m 0755 "$0" /usr/local/sbin/cresslet-backup
  cat > /etc/systemd/system/cresslet-backup.service <<EOF
[Unit]
Description=Snapshot the Cresslet data volume ($VOL)
After=docker.service
[Service]
Type=oneshot
Environment=CRESSLET_BACKUP_DIR=$DIR CRESSLET_BACKUP_KEEP=$KEEP CRESSLET_BACKUP_RCLONE=$REMOTE CRESSLET_BACKUP_KEY_RCLONE=$KEY_REMOTE
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
STEM=cresslet-$(date -u +%Y%m%dT%H%M%SZ)
TMP=.$STEM.$$  # staging, per run
trap 'rm -f "$DIR/$TMP.part" "$DIR/$TMP.key"' EXIT
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
  # secrets.key: not in the snapshot (kept apart, below).
  ex="$ex --exclude=./secrets.key"
  [ ! -f secrets.key ] || install -m 600 secrets.key "/out/'"$TMP"'.key"
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
  tar czf "/out/'"$TMP"'.part" -C /s .'

# The key, apart. It never changes, so this is normally one file; a new one (a new volume?) is kept
# beside the old, which older snapshots need.
FP=
if [ -f "$DIR/$TMP.key" ]; then
  FP=-$(sha256sum "$DIR/$TMP.key" | cut -c1-12)
  if [ ! -f "$DIR/secrets$FP.key" ]; then
    mv "$DIR/$TMP.key" "$DIR/secrets$FP.key"
  elif ! cmp -s "$DIR/$TMP.key" "$DIR/secrets$FP.key"; then
    echo "cresslet-backup: $DIR/secrets$FP.key was damaged: replaced with the volume's key" >&2
    mv "$DIR/$TMP.key" "$DIR/secrets$FP.key"
  fi
else
  echo "cresslet-backup: no secrets.key in $VOL (CRESSLET_SECRETS_KEY?): keep that key off-site yourself"
fi
NAME=$STEM$FP.tgz
mv "$DIR/$TMP.part" "$DIR/$NAME"
chmod 600 "$DIR/$NAME"
echo "cresslet-backup: $DIR/$NAME ($(du -h "$DIR/$NAME" | cut -f1))"

# Newest $KEEP stay.
ls -1t "$DIR"/cresslet-*.tgz | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done

# Off-site: the keys first (a snapshot is no use without its key).
rc=0
if [ -n "$KEY_REMOTE" ]; then
  # --immutable: an existing copy that differs is an error, not overwritten (copyto would replace it).
  rclone copy --immutable --checksum --include "/secrets-*.key" "$DIR" "$KEY_REMOTE"
  [ -z "$FP" ] || echo "cresslet-backup: secrets$FP.key in $KEY_REMOTE"
elif [ -n "$REMOTE" ] && [ -n "$FP" ]; then
  echo "cresslet-backup: CRESSLET_BACKUP_KEY_RCLONE unset: snapshots off-site can't be restored without secrets$FP.key" >&2
  rc=1
fi
if [ -n "$REMOTE" ]; then
  rclone copyto "$DIR/$NAME" "$REMOTE/$NAME"
  echo "cresslet-backup: copied to $REMOTE/$NAME"
fi
exit "$rc"
