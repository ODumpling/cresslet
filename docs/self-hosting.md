# Self-hosting

```sh
CRESSLET_DOMAIN=cresslet.example.com CRESSLET_SCHEME=https CRESSLET_PUBLIC_PORT=443 \
CRESSLET_DATA_DIR=/var/lib/cresslet npm start
```

Needs wildcard DNS (`*.cresslet.example.com` + `cresslet.example.com` → server) and TLS in front, e.g. Caddy:

```
cresslet.example.com, *.cresslet.example.com {
  tls {
    dns cloudflare {env.CF_API_TOKEN}
  }
  reverse_proxy localhost:8787
}
```

Custom domains (`POST /v1/apps/:name/domains`, verified by a TXT record) also need certificates for hostnames you don't know in advance. With Caddy, on-demand TLS asks the server; the whole Caddyfile then is (global options first):

```
{
  on_demand_tls {
    ask http://localhost:8787/v1/domains/check
  }
}

cresslet.example.com, *.cresslet.example.com {
  tls {
    dns cloudflare {env.CF_API_TOKEN}
  }
  reverse_proxy localhost:8787
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy localhost:8787
}
```

The check only approves verified custom domains; the root and `*.<domain>` are covered by the explicit site block above.

Other proxies (Traefik, Coolify) need each verified domain added to the proxy by hand.

| Env | Default | |
|---|---|---|
| `PORT` | 8787 | listen port |
| `CRESSLET_DOMAIN` | localhost | apps at `<name>.<domain>` |
| `CRESSLET_SCHEME` / `CRESSLET_PUBLIC_PORT` | http / PORT | used in generated URLs |
| `CRESSLET_DATA_DIR` | ./data | metadata + app data |
| `CRESSLET_SOCK_DIR` | /tmp/cresslet-sock | sandbox sockets (keep path short) |
| `CRESSLET_WORKERD` | bundled `workerd` npm binary | binary used for sandboxes |
| `CRESSLET_OPEN_SIGNUP` | true | any GitHub user can create an account (false: only operator-created accounts) |
| `CRESSLET_ANON_DEPLOYS` | true | allow deploys without an account (expiring apps) |
| `CRESSLET_SECRETS_KEY` | random, in `<dataDir>/secrets.key` | key for app secrets at rest (any string). Set it to keep the key out of the data volume; existing secrets are re-encrypted on start. Changing it later needs the old `secrets.key` still present. Rolling back to a version without encryption isn't supported (it would hand apps ciphertext). Back up `secrets.key` with `cresslet.db` (without it the server won't start); on the same volume it doesn't protect a leaked volume or backup, the env key does |
| `CRESSLET_ADMIN_TOKEN` | — | bearer token for `POST /v1/accounts` (pre-create accounts / issue tokens) |
| `CRESSLET_GITHUB_CLIENT_ID` / `_SECRET` | — | GitHub OAuth App: the only user login (studio + CLI). Unset = no login, anonymous deploys only |
| `CRESSLET_GITHUB_URL` / `CRESSLET_GITHUB_API_URL` | github.com / api.github.com | GitHub Enterprise Server |
| `CRESSLET_MAX_DEPLOY_MB` / `_FILES` / `CRESSLET_MAX_SERVER_MB` | 25 / 2000 / 5 | |
| `CRESSLET_REQUEST_TIMEOUT_MS` | 30000 | |
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

Accounts are keyed by GitHub user id. First GitHub login links to an existing (operator-created) account with the same **verified** GitHub email and revokes its older tokens; otherwise it creates one, if `CRESSLET_OPEN_SIGNUP` allows. Users find their API token in the studio under **Settings** (show, copy, regenerate) or run `cresslet login`.

Docker: the repo `Dockerfile` runs the server on port 8787 with data in `/data` (mount a volume). Sandboxes are plain child processes, so no extra privileges are needed.

`*.localhost` resolves to 127.0.0.1 in browsers and curl, so local dev needs no DNS setup.

v1 caveats: one server process (no horizontal scaling). See [architecture.md](architecture.md#roadmap).
