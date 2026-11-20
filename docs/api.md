# HTTP API (v1)

Base: `http://localhost:8787` (self-hosted default). JSON in/out. CORS `*`.

Auth (either):
- `Authorization: Bearer clv_acct_…` (or `clv_scoped_…`) — account token (GitHub login, or created in the studio under Settings → API tokens).
- `X-Cresslet-Deploy-Key: clv_app_…` (or `Authorization: Bearer clv_app_…`) — per-app key, returned once on app creation.

Site admin = an account with the `SiteAdmin` role (or listed in `CRESSLET_SITE_ADMINS`) using a full-access token (`admin`, all apps), or the operator's `CRESSLET_ADMIN_TOKEN`. The studio shows them an **Admin** page (`/#/admin`).

Errors: `{ "error": "<code>", "message": "…" }` with 4xx/5xx.

Account tokens have a **role** and optionally a list of **apps** (403 `forbidden` outside them):
- `read`: `GET` endpoints of the account's apps (app, logs, source, secret names, egress, domains, db) and `POST /apps/:name/db/query` (read-only).
- `deploy`: `read`, plus `POST /deploys` (existing apps) and `POST /apps/:name/rollback`. Deployed code can read the app's secrets, so treat it as close to `admin` for that app.
- `admin`: everything on the apps (secrets, egress, domains, delete).
- `apps`: limit the token to these apps (by id: a deleted app doesn't come back into scope if its name is reused). Without it, the token covers every app, including new ones.

Creating apps, claiming apps and managing tokens (`/v1/me/tokens`, `/v1/me/token`) need `admin` over all apps. Tokens issued before named tokens, and login tokens, are `admin` over all apps. `GET /v1/me` works with any token. Deploy keys (`clv_app_…`) are unchanged: full access to their one app.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1` | server info, limits, app URL template, `auth: {github}` |
| POST | `/v1/accounts` | **admin token only**: `{email}` → `{account, token}`. Pre-create an account (GitHub login with that verified email links to it) |
| GET | `/v1/me` | `{account: {id, email, github, role}, token}` (`github` = login or null; `role` = `"SiteAdmin"` or null); `token: {id, name, role, apps, createdAt, lastUsedAt}` for the calling token (any scope) |
| GET | `/v1/me/tokens` | `{tokens: [{id, name, role, apps, createdAt, lastUsedAt, current}]}`; never the secret |
| POST | `/v1/me/tokens` | `{name, role?: read\|deploy\|admin (default admin), apps?: ["name", …] \| null}` → `{token, info}` (201). The secret is only in this response. Scoped tokens start `clv_scoped_` |
| DELETE | `/v1/me/tokens/:id` | revoke one token |
| POST | `/v1/me/token` | revoke all of this account's tokens → `{account, token}` (new full-access one) |
| GET | `/v1/auth/github` | browser: GitHub web flow → redirects to `/#cresslet_login=<code>` (or `#cresslet_login_error=…`) |
| POST | `/v1/auth/exchange` | `{code}` (one-time, 60s) → `{account, token}` |
| POST | `/v1/auth/github/device` | CLI/agents: → `{deviceCode, userCode, verificationUri, expiresIn, interval}` |
| POST | `/v1/auth/github/device/token` | `{deviceCode}` → `{status: pending\|slow_down}` or `{status: complete, account, token}`; poll every `interval`s |
| GET | `/v1/templates` | `{templates: [{name, description}]}` |
| GET | `/v1/templates/:name` | `{files: [{path, data, encoding: utf8\|base64}]}` |
| POST | `/v1/deploys` | see below |
| GET | `/v1/apps` | account's apps |
| GET | `/v1/apps/:name` | app, last 10 deploys, runtime status, secret names |
| DELETE | `/v1/apps/:name` | delete app + data |
| POST | `/v1/apps/:name/claim` | account auth + `{deployKey}` → no expiry, net + secrets |
| POST | `/v1/apps/:name/rollback` | `{deployId?}` (default: previous) |
| GET | `/v1/apps/:name/source?deploy=` | `{app, deployId, files: [{path, data, encoding}]}` source uploaded with the current (or given) deploy; 404 `no_source` if none |
| GET | `/v1/apps/:name/logs?n=200&follow=1` | NDJSON `{t, kind: stdout\|stderr\|system\|request, msg}`; `follow` streams |
| GET | `/v1/apps/:name/secrets` | `{keys}` (values are write-only) |
| PUT | `/v1/apps/:name/secrets` | `{KEY: "value" \| null}` merge; claimed apps only |
| DELETE | `/v1/apps/:name/secrets/:key` | |
| GET | `/v1/apps/:name/egress` | `{allow}`: hostnames the server may `fetch`, or `null` = any public host |
| PUT | `/v1/apps/:name/egress` | `{allow: ["api.stripe.com", "*.openai.com"] \| null}` (≤ 50; `*.` = subdomains only); claimed apps only. Blocked requests get 403 and a log line; raw sockets are refused under an allowlist |
| GET | `/v1/apps/:name/domains` | `{domains: [{domain, verified, dns: [{type, name, value}]}]}` (claimed apps) |
| POST | `/v1/apps/:name/domains` | `{domain}` → pending; `dns` lists the CNAME to point at the app and the TXT `_cresslet.<domain>` proving ownership. Max 10 |
| POST | `/v1/apps/:name/domains/:domain/verify` | checks the TXT record; first app to verify a domain gets it (409 after) |
| DELETE | `/v1/apps/:name/domains/:domain` | |
| GET | `/v1/domains/check?domain=` | 200 if it's a verified custom domain, else 404. For on-demand TLS (the root and app subdomains use the wildcard cert) |
| GET | `/v1/apps/:name/db?limit=100` | tables → `{schema, count, rows}` |
| POST | `/v1/apps/:name/db/query` | `{sql, params?}` read-only → `{rows}` |
| GET | `/v1/admin/sites` | **site admin**: every site (deleted too) → `{totals, retentionDays, sites: [{name, url, status: running\|idle\|empty\|deleted, owner, domains, currentDeploy, usage: {deploys, database, files, total} (bytes on disk), deletedAt, purgeAt, …}]}` |
| GET | `/v1/admin/sites/:name` | **site admin**: `{site, deploys, domains, secrets (count), database: {tables: [{name, rows}]}, runtime}` |
| DELETE | `/v1/admin/sites/:name` | **site admin**: soft delete. Offline at once (not served, no crons, 404 to its owner, name stays taken) and restorable until purged after `CRESSLET_DELETED_RETENTION_DAYS`. `?purge=1` deletes it and its data permanently now |
| POST | `/v1/admin/sites/:name/restore` | **site admin**: undo a soft delete |
| PUT | `/v1/admin/accounts/role` | **site admin**: `{email, role: "SiteAdmin" \| null}` grant/revoke (not your own) |

## POST /v1/deploys

```json
{
  "app": "my-app",
  "files": [{ "path": "index.html", "data": "<h1>hi</h1>", "encoding": "utf8" },
            { "path": "assets/logo.png", "data": "iVBOR…", "encoding": "base64" }],
  "server": "export default { fetch(req, env) { … } }",
  "config": { "routes": ["/api/*"], "crons": ["0 * * * *"] },
  "source": "cli"
}
```

- `app` omitted → random name. `app` unknown → created with that name. `app` exists → needs auth.
- Anonymous create → app expires (`expiresAt`), response includes `deployKey` (store it).
- Logged-in create → claimed immediately.
- `files` = built static output. `server` = single ESM bundle (or omit for static).
- `config.crons` (optional, ≤ 5, needs `server`): cron expressions that call the server's `scheduled()` export (claimed apps; see app-format.md).
- `sources` (optional, same shape as `files`): the project source, stored with the deploy (not served) so another client can open it. Shares the size/file limits with `files`; if it doesn't fit, the deploy succeeds without it and the response's `deploy.warning` says so. Dropped (case-insensitive): any `.env*` name containing `local` or `cresslet`, `.envrc*`, `.dev.vars*`, top-level `dist/`, any `node_modules/`, `.git/` or `.cresslet/`. Other `.env*` files keep only their `CRESSLET_PUBLIC_*` / `VITE_*` entries, fail-closed: only single-line `NAME=value` lines (non-empty unquoted, or backslash-free `'…'`/`"…"`) are understood, comments are dropped, and the first other line ends the file. The studio sends it.
- Each deploy is immutable; activation is atomic; sandbox restarts on next request.

Response `201`:

```json
{ "app": { "id", "name", "url", "claimed", "expiresAt", "currentDeployId", "config" },
  "deploy": { "id", "bytes", "files", "server" },
  "deployKey": "clv_app_…" }
```

## Minimal agent deploy (no CLI)

```sh
curl -s localhost:8787/v1/deploys -H 'content-type: application/json' \
  -d '{"files":[{"path":"index.html","data":"<h1>hello</h1>"}]}'
```
