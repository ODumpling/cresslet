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

In Coolify: build pack Docker Compose, compose location as above, and the `CRESSLET_*` variables the compose file reads (`CRESSLET_DOMAIN` is required; `CRESSLET_OPEN_SIGNUP` and `CRESSLET_ANON_DEPLOYS` default to `false` here). `CRESSLET_CONTAINER_MEMORY` / `CRESSLET_CONTAINER_CPUS` (default `3g` / `2`) cap the whole container. No domain is set in Coolify: the compose file's Traefik labels route `<domain>` and `*.<domain>`. Coolify doesn't expand variables in labels, so edit the domain in them.

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

A network that doesn't exist yet (the first deploy, or one Coolify recreated) is covered within a minute of its creation; a connection opened in that minute stays up. Run the script once right after the first deploy.

Notes:
- gVisor's network stack can't reach Docker's embedded DNS (127.0.0.11) on a user-defined network ([gVisor FAQ](https://gvisor.dev/docs/user_guide/faq/)), so the entrypoint writes public resolvers (`CRESSLET_RESOLVERS`, default `1.1.1.1 9.9.9.9`) into `/etc/resolv.conf`. The container can't look up other containers by name (it doesn't need to).
- This mode doesn't use `CRESSLET_RUNSC` (gVisor per sandbox, which needs a privileged container) or `CRESSLET_CGROUP_DIR`. The uids keep apps out of each other's files and the control plane's. Each sandbox still has its heap cap and request timeout, and the container caps bound them all.
- Rolling back: the server ran as root here, so files it created in the volume are root's. Give them back to the Dockerfile image's `node` user (`docker run --rm -v <volume>:/data alpine chown -R 1000:1000 /data`), switch the build pack back to Dockerfile (it mounts the old `<app uuid>-cresslet-data` volume, without the writes made since; copy back the same way to keep them). Then `systemctl disable --now cresslet-firewall.timer cresslet-firewall-boot.service` and `systemctl stop cresslet-firewall.service` first (or a run puts the rules back), and `firewall.sh <app uuid> --remove`.

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
| `CRESSLET_SECRETS_KEY` | random, in `<dataDir>/secrets.key` | key for app secrets at rest (any string). Set it to keep the key out of the data volume; existing secrets are re-encrypted on start. Changing it later needs the old `secrets.key` still present. Rolling back to a version without encryption isn't supported (it would hand apps ciphertext). Back up `secrets.key` with `cresslet.db` (without it the server won't start); on the same volume it doesn't protect a leaked volume or backup, the env key does |
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
| `CRESSLET_APP_CPU_PERCENT` / `CRESSLET_APP_PIDS` | 100 / 256 | per-sandbox `cpu.max` (100 = one core) / `pids.max` (threads count), with `CRESSLET_CGROUP_DIR` |
| `CRESSLET_APP_MEMORY_MB` | 256 | V8 heap cap |
| `CRESSLET_IDLE_MS` | 300000 | stop idle sandboxes |
| `CRESSLET_ANON_TTL_HOURS` | 72 | unclaimed app lifetime |

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

v1 caveats: one server process (no horizontal scaling). See [architecture.md](architecture.md#roadmap).
