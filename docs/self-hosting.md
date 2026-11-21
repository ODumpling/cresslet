# Self-hosting

```sh
CRESSLET_DOMAIN=cresslet.example.com CRESSLET_SCHEME=https CRESSLET_PUBLIC_PORT=443 \
CRESSLET_DATA_DIR=/var/lib/cresslet npm start
```

Needs wildcard DNS (`*.cresslet.example.com` + `cresslet.example.com` → server) and TLS in front. The server speaks plain HTTP; [Production](#production) puts Caddy in front.

## Production

[`deploy/`](../deploy) runs the server behind Caddy with Docker Compose (≥ 2.24):

```sh
cd deploy
cp .env.example .env && $EDITOR .env                  # set CRESSLET_DOMAIN
cp caddy.env.example caddy.env && $EDITOR caddy.env   # set CLOUDFLARE_API_TOKEN (only read from here)
$EDITOR cresslet.env             # optional: other CRESSLET_* settings (GitHub login, admin token, limits)
docker compose up -d --build
```

DNS: `A`/`AAAA` for `cresslet.example.com` and `*.cresslet.example.com` → the server, DNS only (on Cloudflare: not proxied, or Cloudflare's edge certificate, which doesn't cover `*.cresslet.example.com`, answers instead of Caddy). The same goes for custom domains' CNAMEs and an off-domain preview host: a TLS-terminating proxy in front answers with its own certificate and can block the ACME challenges, so the on-demand cert never issues. Ports 80 and 443 (TCP, plus UDP for HTTP/3) open. Data lives in the `cresslet_data` volume (back it up, with `secrets.key`); Caddy's certificates and ACME account in `caddy_data` (losing it means re-issuing everything, against the CA rate limits).

Certificates ([`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile)):

| Host | Certificate |
|---|---|
| `cresslet.example.com` (studio, API) | its own, DNS-01 |
| `<app>.cresslet.example.com`, `preview.cresslet.example.com` | one wildcard `*.cresslet.example.com`, DNS-01 |
| verified custom domains | per host, on demand (TLS-ALPN-01 / HTTP-01) at the first handshake, only if `GET /v1/domains/check?domain=…` returns 200 |
| `CRESSLET_PREVIEW_HOST` outside the domain | on demand, same check |

Why Caddy instead of ACME in the server: wildcard certs need DNS-01 (a DNS provider API) and custom domains need certs for names known only at runtime. Caddy does both (DNS provider modules, on-demand TLS gated by an `ask` endpoint), plus renewal and HTTP/3, so the server stays a plain HTTP process with one read-only endpoint for it. The check approves only DNS-verified custom domains (and an off-domain preview host): app subdomains are on the wildcard, and approving every app name would let anyone spend the CA's rate limit by creating apps.

DNS provider: Cloudflare by default (API token with Zone → Zone → Read and Zone → DNS → Edit on the zone). Another provider: set `CADDY_DNS_MODULE` in `.env` to its [`caddy-dns`](https://github.com/caddy-dns) module, put its config in `deploy/caddy/dns.caddy` and its credentials in `deploy/caddy.env`. Try a new setup against Let's Encrypt staging first (`acme_ca …` in `deploy/caddy/options.caddy`).

Without Compose: a Caddy built with the DNS module (`xcaddy build --with github.com/caddy-dns/cloudflare`), `CRESSLET_DOMAIN` and the token in its environment, and the same Caddyfile (plus its two imported files) with `cresslet:8787` replaced by the server's address. Other proxies (Traefik, Coolify) need the wildcard cert configured by hand and each verified custom domain added by hand (or their own on-demand mechanism pointed at `/v1/domains/check`).

Behind Cloudflare's proxy instead (no Caddy, e.g. on Coolify): if `CRESSLET_DOMAIN` is the zone apex, Universal SSL already covers `<domain>` and `*.<domain>` at the edge, so proxied records work and the origin only needs a certificate Cloudflare accepts. Custom domains don't: Cloudflare won't proxy hostnames from other accounts' zones without Cloudflare for SaaS.

`deploy/test/acme.sh` runs this compose file end to end against [Pebble](https://github.com/letsencrypt/pebble) (a test CA) and a local bind9: wildcard via real DNS-01, a verified custom domain via on-demand TLS, an unverified one refused. It needs Docker and Node, and touches no real DNS.

### Coolify

[`deploy/coolify/compose.yaml`](../deploy/coolify/compose.yaml) is for Coolify's Docker Compose build pack (compose location `/deploy/coolify/compose.yaml`), on a host shared with other apps. It runs the whole container under gVisor, with one uid per app sandbox, its own network, and CPU/memory/pids caps. The proxy in front (Traefik with Cloudflare proxied, as above) is Coolify's.

On the host, once (root):

```sh
# gVisor from its apt repo (https://gvisor.dev/docs/user_guide/install/), registered with Docker.
# `systemctl reload docker` picks up the new runtime without restarting running containers.
runsc install && systemctl reload docker
docker run --rm --runtime=runsc alpine uname -r     # 4.19.0-gvisor (or newer)
```

In Coolify: build pack Docker Compose, compose location as above, and the `CRESSLET_*` variables the compose file reads (`CRESSLET_DOMAIN` is required; `CRESSLET_OPEN_SIGNUP` and `CRESSLET_ANON_DEPLOYS` default to `false` here). `CRESSLET_CONTAINER_MEMORY` / `CRESSLET_CONTAINER_CPUS` (default `3g` / `2`) cap the whole container. The abuse limits default lower here than the server's ([Sizing a shared host](#sizing-a-shared-host)). Behind Cloudflare, set `CRESSLET_CLIENT_IP_HEADER=cf-connecting-ip` for the per-IP limits. Other `CRESSLET_*` settings need a line under `environment:` too (Coolify passes only the variables the file names). No domain is set in Coolify: the compose file's Traefik labels route `<domain>` and `*.<domain>`. Coolify doesn't expand variables in labels, so edit the domain in them.

Coolify names the data volume `<app uuid>_data`. Switching an existing Dockerfile deploy (volume `<app uuid>-cresslet-data`) means copying its data across once, just before the first compose deploy. SQLite's `.backup` makes the copy safe while the old container is still running:

```sh
U=<app uuid>
docker volume create ${U}_data
docker run --rm -v $U-cresslet-data:/old -v ${U}_data:/new alpine sh -ec '
  apk add -q sqlite; cp -a /old/. /new/; cd /old
  for db in cresslet.db apps/*/data/db.sqlite apps/*/data/files/index.sqlite; do
    [ -f "$db" ] || continue; mkdir -p "$(dirname "/new/$db")"; rm -f "/new/$db" "/new/$db-wal" "/new/$db-shm"; sqlite3 "$db" ".backup /new/$db"
  done'
```

Writes that reach the old container between the copy and the switch aren't carried over, and a file an app stores during the copy can be missing from it, so copy right before deploying (or stop the old deploy first).

Then keep that network off the host and private ranges (another app's database, the host's SSH and Coolify's own port, cloud metadata). The rules are re-applied every minute in case the network is recreated, and loaded at boot (from the bridge name the last run saved) before Docker starts containers:

```sh
deploy/coolify/firewall.sh <app uuid> --install     # <app uuid> = the compose app's network
```

A network that doesn't exist yet (the first deploy, or one Coolify recreated) is covered within a minute of its creation; a connection opened in that minute stays up. Run the script once right after the first deploy. If the rules can't be applied, the script stops the containers on that network (not Coolify's proxy) rather than leave them unfirewalled; start them again once it's fixed. It handles one Cresslet network per host.

Then the alerts ([Alerts](#alerts)), with the same network:

```sh
CRESSLET_ALERT_URL=https://ntfy.sh/<secret topic> deploy/coolify/alerts.sh <app uuid> --install
cresslet-alerts <app uuid> --test     # a test alert should arrive
```

Notes:
- gVisor's network stack can't reach Docker's embedded DNS (127.0.0.11) on a user-defined network ([gVisor FAQ](https://gvisor.dev/docs/user_guide/faq/)), so the entrypoint writes public resolvers (`CRESSLET_RESOLVERS`, default `1.1.1.1 9.9.9.9`) into `/etc/resolv.conf`. The container can't look up other containers by name (it doesn't need to).
- The compose file sets `CRESSLET_OUTER_GVISOR=true` (the container runs under `runtime: runsc`), so the server doesn't warn about missing gVisor.
- This mode doesn't use `CRESSLET_RUNSC` (gVisor per sandbox, which needs a privileged container) or `CRESSLET_CGROUP_DIR`. The uids keep apps out of each other's files and the control plane's. Each sandbox still has its heap cap and request timeout, and the container caps bound them all.
- Rolling back: the server ran as root here, so files it created in the volume are root's. Give them back to the Dockerfile image's `node` user (`docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data`), switch the build pack back to Dockerfile (it mounts the old `<app uuid>-cresslet-data` volume, without the writes made since; copy back the same way to keep them). Then `systemctl disable --now cresslet-firewall.timer cresslet-firewall-boot.service cresslet-alerts.timer` and `systemctl stop cresslet-firewall.service` first (or a run puts the rules back), and `firewall.sh <app uuid> --remove`.

### Sizing a shared host

cresslet.dev runs on 4 vCPU, 7.6 GB of memory (no swap) and a 72 GB disk (58 GB free), shared with other apps and Coolify, which builds on the same host. What the limits allow there, at the compose file's defaults (estimates of what the quotas count: payload bytes. On disk it's more: a long write transaction grows a WAL past 64 MB until it ends, and many small files take filesystem blocks, directories and index rows beyond their bytes, so the quotas don't bound disk use; the disk and inode alerts do the rest):

| | Bound | Worst case (about) |
|---|---|---|
| CPU | the container: 2 of 4 vCPU (`CRESSLET_CONTAINER_CPUS`) | the other apps keep 2 |
| Memory | the container: 3 GB of 7.6 (`CRESSLET_CONTAINER_MEMORY`); each sandbox's V8 heap: 128 MB (`CRESSLET_APP_MEMORY_MB`, Cloudflare Workers' limit too) | the other apps (about 2 GB today) and builds keep the rest. About 12–15 sandboxes at a full heap fill the container (each also has workerd's own memory and a bindings thread); idle ones stop after `CRESSLET_IDLE_MS`, but nothing caps how many are awake at once |
| One app's disk | database 128 MB (+ up to 64 MB of WAL) + files 256 MB + 10 deploys kept × (25 MB of files + a server bundle: 5 MB of characters, up to 15 MB of UTF-8) | ≈ 0.85 GB |
| One account | 10 apps (`CRESSLET_MAX_APPS_PER_ACCOUNT`) | ≈ 8.5 GB |
| Anonymous apps | 25 live (`CRESSLET_MAX_ANON_APPS`), 5 new per IP per hour; gone after 72 h | ≈ 21 GB |
| Local backups ([Backups](#backups)) | `CRESSLET_BACKUP_KEEP` (14) archives, and during a run an uncompressed copy of the volume (in Docker's storage) and the new archive | up to `CRESSLET_BACKUP_KEEP` + 2 (16) × the volume, less what compresses |

The server's own defaults (512 MB databases, 1 GB of files, 50 apps per account, 200 anonymous apps) allow ≈ 2 GB per app (counted the same way), 100 GB per account and 400 GB of anonymous apps: they don't fit this disk.

The worst cases don't fit either, and no limit bounds the total: accounts aren't capped, so with open signup every GitHub account adds up to 8.5 GB. A disk that fills up stops the other apps' databases too. The disk alert ([Alerts](#alerts)) at 80% is the backstop: about 42 GB of growth on this host, but every GB in the volume costs up to `CRESSLET_BACKUP_KEEP + 3` GB on disk at a backup run's peak (itself, the kept archives, the new one and the staging copy; less what compresses), so the alert can fire after about 2.5 GB of new app data at `CRESSLET_BACKUP_KEEP=14`, or 7 GB at 3. Before opening signup, set up [off-site](#off-site) snapshots and reinstall the backups with `CRESSLET_BACKUP_KEEP=3`. When it fires: see who uses what on the studio's Admin page and **Delete**, then **Purge**, their sites (deleted ones keep their data for `CRESSLET_DELETED_RETENTION_DAYS` until purged), if it's abuse, close signup and anonymous deploys again (that stops new accounts and new anonymous apps; existing accounts still create apps up to their limit, and an anonymous app's deploy key still updates it, so deal with those sites too), and delete old local snapshots if they're the bulk. A full container (memory alert, or restarts) affects only Cresslet. Five client IPs can also fill the anonymous pool in an hour, and keep it full: anonymous deploys then return 429 for everyone until those apps expire (accounts still deploy).

### Alerts

[`deploy/coolify/alerts.sh`](../deploy/coolify/alerts.sh) checks the host every minute (a systemd timer, as root) and alerts when:

| Check | Fires when |
|---|---|
| disk | a filesystem holding Docker's data or the backups (`CRESSLET_ALERT_PATHS`) is `CRESSLET_ALERT_DISK_PCT` (80) % full, or has used that much of its inodes (many small files) |
| memory | the host has `CRESSLET_ALERT_MEM_PCT` (90) % of its memory in use (from `MemAvailable`), or a Cresslet container that much of its limit |
| restart | a running Cresslet container's restart count went up since the last check (an OOM kill or a crash; several in a minute are one alert; Docker doesn't keep which, see `docker logs` and `journalctl -k`). A container that stays stopped isn't checked: Coolify shows it |
| firewall | `cresslet-firewall` fails (its own alert); it failed closed and stopped Cresslet, until its first run after Cresslet runs again (start or redeploy it in Coolify once the rules apply); or it couldn't stop a container, which runs unfirewalled until the rules apply. Each of these is its own alert |
| backup | the last `cresslet-backup` run failed |

The firewall alert also fires while the network is missing (its first deploy, or Coolify recreating it) and, for good, while Cresslet is stopped in Coolify on purpose: then `systemctl disable --now cresslet-alerts.timer` (and `enable --now` again with Cresslet). Each goes to the journal (`journalctl -t cresslet-alert`) and, with `CRESSLET_ALERT_URL`, is POSTed there: plain text by default (an [ntfy](https://ntfy.sh) topic: pick a long random name, since anyone who knows it can read it), or `{"<key>": "<text>"}` with `CRESSLET_ALERT_JSON_KEY` (`content` for a Discord webhook, `text` for Slack). One alert when a check starts failing and one when it recovers (disk and memory recover 5 points under the threshold; a check that couldn't measure doesn't recover). Alerts go to the URL after the checks (a slow URL can't hold them up); one it doesn't take (an error, a timeout) is in the journal right away and sent by a later run, with the time it happened, even if the problem is over by then. A run started while another is going (by hand, say) does nothing. With the disk full, an alert can't be recorded as sent: it goes again each minute until there's room. `--install` writes the settings to `/etc/cresslet-alerts.env` (root-only, as the URL is a secret): rerun it with all of them to change one. Coolify's own disk notification (if its notifications are set up) only checks once a day.

## Backups

Everything lives in the data volume: `cresslet.db`, `secrets.key` (without it the server won't start and app secrets can't be read), every app's deploys, database and files. [`deploy/backup.sh`](../deploy/backup.sh) snapshots it on the Docker host (root) while the server runs: each SQLite database through `.backup` (consistent) and an integrity check, the rest copied, as one `.tgz`. `secrets.key` isn't in the snapshot: it's kept apart, as `secrets-<fingerprint>.key`, and each snapshot's name ends with the fingerprint of the key it needs (`cresslet-20261120T033012Z-1a2b3c4d5e6f.tgz`).

```sh
deploy/backup.sh <volume>              # one snapshot now, in /var/backups/cresslet
deploy/backup.sh <volume> --install    # daily at 03:30 (systemd timer)
```

`CRESSLET_BACKUP_KEEP` (default 14) snapshots stay, and every key. Each database in a snapshot is consistent, but not with everything else at one instant: a file an app stores, or a deploy, during the snapshot can be in the database and not the copy (or the other way round). For a copy that's consistent as a whole, stop the server first (in Coolify, stop the app), run the script, start it again.

### Off-site

A snapshot on the same disk doesn't survive losing that disk. With [rclone](https://rclone.org/install/) installed and set up for root, `CRESSLET_BACKUP_RCLONE` gets a copy of each snapshot and `CRESSLET_BACKUP_KEY_RCLONE` gets the keys. Make them two remotes with their own credentials, on two buckets, so a leaked bucket or token holds the data or the key, never both (the host holds both tokens, as it holds the volume). Any S3-compatible storage works (Cloudflare R2, Backblaze B2, AWS S3, …).

Install rclone from rclone.org, not the distro. For R2, older rclone (Ubuntu 26.04's `v1.60.1-DEV`) follows each upload with a check R2 rejects (`501 NotImplemented`): the file is up and rclone's retry passes, but every upload logs a failed attempt. `v1.76.0` runs clean.

For R2: two buckets and two API tokens (Object Read & Write, each limited to its bucket), in `/root/.config/rclone/rclone.conf` (mode 0600; or `rclone config`, which asks for the same fields, to keep the tokens out of shell history):

```ini
[snaps]
type = s3
provider = Cloudflare
endpoint = https://<account id>.r2.cloudflarestorage.com
access_key_id = <token 1 access key id>
secret_access_key = <token 1 secret access key>
no_check_bucket = true

[keys]
# the same, with token 2
```

Before `--install`, as root, with your bucket names: the first two must exit 0 (no output if the bucket is empty), the last two must fail with `AccessDenied` (any other error isn't a pass).

```sh
rclone lsf snaps:cresslet-snapshots
rclone lsf keys:cresslet-keys
rclone lsf snaps:cresslet-keys
rclone lsf keys:cresslet-snapshots
```

Then:

```sh
CRESSLET_BACKUP_RCLONE=snaps:cresslet-snapshots CRESSLET_BACKUP_KEY_RCLONE=keys:cresslet-keys \
  deploy/backup.sh <volume> --install   # the variables are written into the unit: rerun with them all
systemctl start cresslet-backup; journalctl -u cresslet-backup -n 20   # one run now
```

- A run fails (`systemctl status cresslet-backup`) when an upload fails (the keys go first: a failed key upload stops the snapshot's), or when `CRESSLET_BACKUP_RCLONE` is set without `CRESSLET_BACKUP_KEY_RCLONE` while the volume has a `secrets.key` (the snapshot stays local: off-site it couldn't be restored).
- One snapshot path per volume: a restore takes the newest snapshot there.
- The script doesn't delete off-site snapshots: give the snapshot bucket a lifecycle rule (e.g. delete after 30 days, and noncurrent versions too if it keeps versions), and watch for failed runs ([Alerts](#alerts) does), or a month of them leaves none. Not the key bucket; turn on its versioning or object lock if your storage has them.
- Snapshots made before the key was kept apart hold `secrets.key` themselves: delete them from the snapshot bucket (every version, if it keeps versions) only once a newer snapshot restored with its key (below) gets an app's secret back.
- With `CRESSLET_SECRETS_KEY` set there may be no `secrets.key` to copy: set `CRESSLET_BACKUP_ENV_KEY=true` too (at `--install`), or snapshots without a key file stay local and the run fails (a key file deleted under a running server looks the same, and those snapshots couldn't be restored).
- Keep both tokens (and `CRESSLET_SECRETS_KEY`, if you set it) somewhere other than the server, such as a password manager: a restore after losing the host needs them.
- Snapshots hold every app's database and files (app secrets encrypted with the key): keep the snapshot bucket private. Apart, the key is safe from whoever reads that bucket, not from whoever writes it: a planted app gets the secrets once restored. After a suspected token leak, restore a snapshot uploaded before it that the token couldn't replace or delete: under an R2 bucket lock (pick it by upload time), or an object-locked version elsewhere (versioning alone only if the token can't delete versions; download that version, e.g. `rclone copyto --s3-version-at <time>`), into a fresh `src` directory.

### Restore

On a clean host (or the same one), as root, with Docker and rclone (from rclone.org, as above) installed:

1. The remotes: the same `rclone.conf` as above, with the tokens you kept.
2. The newest snapshot and its key:

   ```sh
   umask 077; src=/root/restore; mkdir -p "$src"
   snap=$(rclone lsf snaps:cresslet-snapshots | grep '^cresslet-.*\.tgz$' | sort | tail -n 1); echo "snapshot: ${snap:-none found}"
   fp=$(echo "$snap" | sed -n 's/^cresslet-[0-9TZ]*-\([0-9a-f]*\)\.tgz$/\1/p')
   [ -n "$snap" ] && rclone copyto "snaps:cresslet-snapshots/$snap" "$src/$snap"
   [ -z "$fp" ] || rclone copyto "keys:cresslet-keys/secrets-$fp.key" "$src/secrets-$fp.key"
   ```

   No fingerprint in the name: the snapshot holds the key itself (made before it was kept apart), or there was no `secrets.key` (`CRESSLET_SECRETS_KEY`). If the host still has its local copies, the same with `ls /var/backups/cresslet` for `rclone lsf …` and `cp /var/backups/cresslet/<file> "$src/"` for each `rclone copyto` (copies, so a snapshot taken in step 3 can't prune them).
3. If backups are installed on this host: `systemctl stop cresslet-backup.timer cresslet-backup` (it waits for a running snapshot to stop), so no snapshot of the volume mid-restore goes off-site (`systemctl start cresslet-backup.timer` after step 5). Then the server stopped, its volume created: deploy once and stop it (Coolify: the volume is `<app uuid>_data`), or `docker volume create <volume>`. Restoring over a volume with data you may want: snapshot it first.
4. Into the volume, once the archive reads and holds `cresslet.db`, and the key matches the snapshot's fingerprint. It's extracted beside what's there (a first start writes its own `cresslet.db` and `secrets.key`), with the key (owned by the owner of `cresslet.db`, the user the server runs as), and replaces it only once that worked: the volume needs room for both.

   ```sh
   docker run --rm -e SNAP="$snap" -e FP="$fp" -v <volume>:/data -v "$src":/r:ro alpine:3.24 sh -ec '
     tar tzf "/r/$SNAP" > /tmp/list
     grep -qxF ./cresslet.db /tmp/list || { echo "no cresslet.db in $SNAP" >&2; exit 1; }
     grep -q "^\./\.restore" /tmp/list && { echo "$SNAP holds ./.restore" >&2; exit 1; }
     [ -z "$FP" ] || [ "$(sha256sum "/r/secrets-$FP.key" | cut -c1-12)" = "$FP" ] || { echo "secrets-$FP.key missing or wrong" >&2; exit 1; }
     s=/data/.restore; rm -rf $s; mkdir $s
     { tar xzf "/r/$SNAP" -C $s && [ -f $s/cresslet.db ] && { [ -z "$FP" ] ||
       install -m 600 -o "$(stat -c %u $s/cresslet.db)" -g "$(stat -c %g $s/cresslet.db)" "/r/secrets-$FP.key" $s/secrets.key; }; } ||
       { rm -rf $s; exit 1; }
     find /data -mindepth 1 -maxdepth 1 ! -name .restore -exec rm -rf {} +
     for e in $s/* $s/.[!.]* $s/..?*; do [ ! -e "$e" ] || mv "$e" /data/; done
     chown "$(stat -c %u:%g $s)" /data; chmod "$(stat -c %a $s)" /data; rmdir $s'
   ```

5. Start the server (with the same `CRESSLET_SECRETS_KEY`, if you set one). The studio lists the apps, and an app that reads a secret gets it back (a wrong or missing key stops the server: `cannot decrypt secret …`; if the volume's key was ever replaced, e.g. a lost `secrets.key` regenerated at a restart, an older kept key may be the one: `rclone lsf keys:cresslet-keys`, copy it as in step 2 and run step 4 again with `fp=<its fingerprint>`). Then turn backups on for this host (as above).

## Configuration

| Env | Default | |
|---|---|---|
| `PORT` | 8787 | listen port |
| `CRESSLET_DOMAIN` | localhost | apps at `<name>.<domain>` |
| `CRESSLET_PREVIEW_HOST` | `preview.<domain>` | origin for studio previews (covered by the wildcard DNS/cert); its name is reserved for apps. `CRESSLET_SCHEME` / `CRESSLET_PUBLIC_PORT` must match the studio's real URL, or the relay refuses to be framed and previews fail; studio pages on any other Host redirect to that URL (a proxy must pass the original Host) |
| `CRESSLET_SCHEME` / `CRESSLET_PUBLIC_PORT` | http / PORT | used in generated URLs |
| `CRESSLET_DATA_DIR` | ./data | metadata + app data |
| `CRESSLET_SOCK_DIR` | /tmp/cresslet-sock | sandbox sockets (keep path short) |
| `CRESSLET_WORKERD` | bundled `workerd` npm binary | binary used for sandboxes |
| `CRESSLET_OPEN_SIGNUP` | true | any GitHub user can create an account (false: only operator-created accounts) |
| `CRESSLET_ANON_DEPLOYS` | true | allow deploys without an account (expiring apps) |
| `CRESSLET_SECRETS_KEY` | random, in `<dataDir>/secrets.key` | key for app secrets at rest (any string). Set it to keep the key out of the data volume; existing secrets are re-encrypted on start. Changing it later needs the old `secrets.key` still present. Rolling back to a version without encryption isn't supported (it would hand apps ciphertext). Back up `secrets.key` (without it the server won't start; [Backups](#backups) keeps it apart from the snapshots); on the same volume it doesn't protect a leaked volume or backup, the env key does |
| `CRESSLET_ADMIN_TOKEN` | — | bearer token for `POST /v1/accounts` (pre-create accounts / issue tokens) |
| `CRESSLET_SITE_ADMINS` | — | comma-separated emails / GitHub logins that always have the `SiteAdmin` role (studio Admin page: every site's disk and database usage, delete/restore/purge). Site admins can grant the role to others (`PUT /v1/admin/accounts/role`) |
| `CRESSLET_DELETED_RETENTION_DAYS` | 30 | sites a site admin deleted stay restorable this long, then are purged with their data |
| `CRESSLET_GITHUB_CLIENT_ID` / `_SECRET` | — | GitHub OAuth App: the only user login (studio + CLI). Unset = no login, anonymous deploys only |
| `CRESSLET_GITHUB_URL` / `CRESSLET_GITHUB_API_URL` | github.com / api.github.com | GitHub Enterprise Server |
| `CRESSLET_MAX_DEPLOY_MB` / `_FILES` / `CRESSLET_MAX_SERVER_MB` | 25 / 2000 / 5 | |
| `CRESSLET_REQUEST_TIMEOUT_MS` | 30000 | |
| `CRESSLET_SANDBOX_UID_BASE` | — | Linux: run each sandbox as uid/gid `base + n` (e.g. `100000`; reserve that range, ≥ 1000). Needs the server to run as root, `CRESSLET_SOCK_DIR` (and its parents) root-owned, and the workerd binary executable by those uids |
| `CRESSLET_CGROUP_DIR` | — | Linux: cgroup v2 dir for per-sandbox cgroups (e.g. `/sys/fs/cgroup/cresslet`); needs a writable cgroupfs |
| `CRESSLET_RUNSC` | — | Linux: run each sandbox under gVisor; the path to `runsc` (e.g. `/usr/local/bin/runsc`). Needs the server to run as root and `CRESSLET_SOCK_DIR` (and its parents) root-owned. See below |
| `CRESSLET_OUTER_GVISOR` | false | `true`: the whole server already runs under gVisor (Docker `--runtime=runsc`, as on [Coolify](#coolify)). It only silences the startup warning ([Docker and isolation](#docker-and-isolation)); the server can't check it |
| `CRESSLET_APP_CPU_PERCENT` / `CRESSLET_APP_PIDS` | 100 / 256 | per-sandbox `cpu.max` (100 = one core) / `pids.max` (threads count), with `CRESSLET_CGROUP_DIR` |
| `CRESSLET_APP_MEMORY_MB` | 256 | V8 heap cap |
| `CRESSLET_IDLE_MS` | 300000 | stop idle sandboxes |
| `CRESSLET_ANON_TTL_HOURS` | 72 | unclaimed app lifetime |
| `CRESSLET_MAX_APPS_PER_ACCOUNT` | 50 | live apps an account may own (new apps and claims past it: 403 `quota`; site admins exempt) |
| `CRESSLET_MAX_ANON_APPS` / `CRESSLET_ANON_APPS_PER_HOUR` | 200 / 10 | live unclaimed apps on the instance / new ones per client IP per hour (429 `rate_limited`) |
| `CRESSLET_DEPLOYS_PER_HOUR` | 120 | deploys per app per hour (429) |
| `CRESSLET_APP_DB_MB` / `CRESSLET_APP_FILES_MB` | 512 / 1024 | per-app database size (SQLite `max_page_count`; apps can't change it) / total size of its files |
| `CRESSLET_CLIENT_IP_HEADER` | — | header with the real client IP for per-IP limits, e.g. `cf-connecting-ip` behind Cloudflare. Without it the TCP peer is used (behind a proxy that's the proxy, so every client shares one allowance). The proxy must set it to the one client address (Cloudflare does for `cf-connecting-ip`); a request that reaches the server some other way can send any value, so set it only if every request comes through that proxy |

Closed instance (`CRESSLET_OPEN_SIGNUP=false CRESSLET_ANON_DEPLOYS=false`): pre-create accounts with the admin token; users then log in with GitHub using that (verified) email. Without GitHub configured, hand out the returned token (`CRESSLET_TOKEN` / `cresslet login --token`).

```sh
curl -X POST https://cresslet.example.com/v1/accounts -H "authorization: Bearer $CRESSLET_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'   # → { token: "clv_acct_…" }
```

## GitHub login

1. GitHub → Settings → Developer settings → **OAuth Apps** → New. Homepage: your root URL. Callback URL: `<root URL>/v1/auth/github/callback` (e.g. `http://localhost:8787/v1/auth/github/callback`, must match `CRESSLET_SCHEME`/`CRESSLET_DOMAIN`/`CRESSLET_PUBLIC_PORT`).
2. Tick **Enable Device Flow** (the CLI uses it; the server proxies it, so the secret never leaves the server).
3. Set `CRESSLET_GITHUB_CLIENT_ID` and `CRESSLET_GITHUB_CLIENT_SECRET`.

Accounts are keyed by GitHub user id. First GitHub login links to an existing (operator-created) account with the same **verified** GitHub email and revokes its older tokens; otherwise it creates one, if `CRESSLET_OPEN_SIGNUP` allows. Users create named API tokens in the studio under **Settings** (read / deploy / admin, optionally limited to some apps; revoke each one alone) or run `cresslet login`.

## Docker and isolation

Where strangers can deploy code (`CRESSLET_ANON_DEPLOYS`, or `CRESSLET_OPEN_SIGNUP` with GitHub login; both settings default on), run it under gVisor: either each sandbox (`CRESSLET_RUNSC`, below) or the whole server (as on [Coolify](#coolify), with `CRESSLET_OUTER_GVISOR=true` and per-app uids). Without gVisor, the server warns at startup: workerd, uids and cgroups alone aren't a hardened multi-tenant boundary ([architecture.md](architecture.md#isolation)). It also warns when sandboxes share one uid without `CRESSLET_RUNSC`. A closed instance (both off) gets no warning.

Docker: the repo `Dockerfile` runs the server on port 8787 with data in `/data` (mount a volume). Sandboxes are plain child processes, so no extra privileges are needed.

Hardened (Linux): per-app uids and cgroup limits on top of workerd. Per-app uids only need root in the container; cgroups need a writable cgroup2 mount in the container's own cgroup namespace, which today means `--privileged`:

```sh
docker run --user root --cgroupns=private --privileged \
  -e CRESSLET_SANDBOX_UID_BASE=100000 -e CRESSLET_CGROUP_DIR=/sys/fs/cgroup/cresslet -e CRESSLET_APP_CPU_PERCENT=50 …
```

The server must be the only process in its cgroup (as the container's PID 1 it is); it moves itself into `/sys/fs/cgroup/control-plane` and delegates `cpu memory pids` to `CRESSLET_CGROUP_DIR`. `--privileged` widens what the *container* may do, so weigh it against your host: the per-app uids alone (`--user root`, no `--privileged`) are the low-risk half. `tests/sandbox_test.ts` shows how to verify a host.

gVisor (Linux): `CRESSLET_RUNSC` runs each sandbox inside gVisor, so code that escapes workerd hits a user-space kernel with no network but its own unix sockets, a private `/tmp`, and a filesystem of only its run dir and system libraries ([architecture.md](architecture.md#isolation)). It combines with the uid and cgroup options. Install gVisor (the release tarball's `runsc` and `gvisor-bin/` go side by side):

```sh
curl -fsSL https://storage.googleapis.com/gvisor/releases/release/20261109.0/$(uname -m)/gvisor.tar.bz2 | tar -xj -C /usr/local/bin runsc gvisor-bin
```

In Docker, runsc needs the container to be privileged (it makes its own namespaces and mounts):

```sh
docker run --user root --privileged --cgroupns=private \
  -e CRESSLET_RUNSC=/usr/local/bin/runsc -e CRESSLET_CGROUP_DIR=/sys/fs/cgroup/cresslet -e CRESSLET_SOCK_DIR=/run/cresslet …
```

Claimed apps' outbound goes through the control plane's egress proxy in this mode (any public host without an allowlist; plain HTTP(S) and plain TCP sockets, not outbound WebSockets or TLS sockets). `CRESSLET_APP_PIDS` also counts gVisor's own threads; raise it if sandboxes fail to start on many-core hosts. The one host dir a sandbox can write is its listener dir under `CRESSLET_SOCK_DIR`; keeping that on a tmpfs (`/run`) bounds it. `CRESSLET_SOCK_DIR` must be at most 50 bytes. `tests/gvisor_test.ts` shows how to verify a host, and the whole suite runs under gVisor with `CRESSLET_RUNSC` set.

`*.localhost` resolves to 127.0.0.1 in browsers and curl, so local dev needs no DNS setup.

v1 caveats: one server process (no horizontal scaling). [architecture.md](architecture.md#scaling-out) describes the seam a second node would use and what is still missing.
