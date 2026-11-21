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

**Collaborators.** An app has one owner (the account that created or claimed it). The owner and the app's admins invite other accounts by email, as `admin` or `viewer`. An invite is pending until the account with that email (shown in its Settings; matched case-insensitively) accepts it with `POST /v1/me/invites/:id/accept`; no email is sent, and inviting an address with no account yet works the same, so it doesn't tell you whether one exists. Access is the collaborator's role, capped by the calling token's role and apps:
- `viewer`: what a `read` token can do (app, logs, source, secret names, egress, domains, db, `db/query`).
- `admin`: everything on the app, including deploys, secrets, egress, domains and managing collaborators, but not deleting it (owner only).
- Managing collaborators needs an account (a deploy key isn't one). Shared apps are listed in `GET /v1/apps` with `access: owner|admin|viewer`, can be named in a token's `apps`, and don't count toward the invitee's app limit. At most 50 collaborators and pending invites per app. Deleting the app removes them.

Creating apps, claiming apps and managing tokens (`/v1/me/tokens`, `/v1/me/token`) need `admin` over all apps. Tokens issued before named tokens, and login tokens, are `admin` over all apps. `GET /v1/me` works with any token. Deploy keys (`clv_app_…`) are unchanged: full access to their one app.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1` | server info, limits, app URL template, `customDomains` (whether apps can add custom domains), `auth: {github, cli}` (`cli`: the browser login below) |
| POST | `/v1/accounts` | **admin token only**: `{email}` → `{account, token}`. Pre-create an account (GitHub login with that verified email links to it) |
| GET | `/v1/me` | `{account: {id, email, github, role}, tokenInfo}` (`github` = login or null; `role` = `"SiteAdmin"` or null); `tokenInfo: {id, name, role, apps, createdAt, lastUsedAt}` for the calling token (any scope) |
| GET | `/v1/me/tokens` | `{tokens: [{id, name, role, apps, createdAt, lastUsedAt, current}]}`; never the secret |
| POST | `/v1/me/tokens` | `{name, role?: read\|deploy\|admin (default admin), apps?: ["name", …] \| null}` → `{token, info}` (201). The secret is only in this response. Scoped tokens start `clv_scoped_` |
| DELETE | `/v1/me/tokens/:id` | revoke one token |
| POST | `/v1/me/token` | revoke all of this account's tokens → `{account, token}` (new full-access one) |
| GET | `/v1/auth/github` | browser: GitHub web flow → redirects to `/#cresslet_login=<code>` (or `#cresslet_login_error=…`) |
| POST | `/v1/auth/exchange` | `{code}` (one-time, 60s) → `{account, token}` |
| POST | `/v1/auth/github/device` | CLI/agents: → `{deviceCode, userCode, verificationUri, expiresIn, interval}` |
| POST | `/v1/auth/github/device/token` | `{deviceCode}` → `{status: pending\|slow_down}` or `{status: complete, account, token}`; poll every `interval`s |
| POST | `/v1/auth/cli` | CLI browser login: → `{deviceCode, userCode, verificationUri, expiresIn, interval}`; open `verificationUri` (the studio's `#/cli`) and show `userCode`, which the user types there. 20 per client per 10 min |
| POST | `/v1/auth/cli/approve` | full-access account token (the studio) + `{userCode}` (case, dashes ignored) → `{approved: true}`; 404 if unknown, expired or already approved. 10 tries per account per 10 min |
| POST | `/v1/auth/cli/token` | `{deviceCode}` → `{status: pending}` or `{status: complete, account, token}` (a new token, once); 400 `expired_token` after, or if the approving token was revoked. Poll every `interval`s |
| GET | `/v1/templates` | `{templates: [{name, description}]}` |
| GET | `/v1/templates/:name` | `{files: [{path, data, encoding: utf8\|base64}]}` |
| POST | `/v1/deploys` | see below |
| GET | `/v1/apps` | apps the account owns or collaborates on; each has `access: owner\|admin\|viewer` |
| GET | `/v1/apps/:name` | app (with the caller's `access`, null for a deploy key), last 10 deploys, runtime status, secret names |
| DELETE | `/v1/apps/:name` | delete app + data (owner or deploy key; not an invited admin) |
| GET | `/v1/apps/:name/collaborators` | **owner or admin**: `{owner: {id, email, github}, collaborators: [{id, email, github, role, createdAt}], invites: [{id, email, role, invitedBy, createdAt}]}` |
| POST | `/v1/apps/:name/collaborators` | **owner or admin**: `{email, role?: viewer\|admin (default viewer)}` → `{invite}` (201; 200 if that email had a pending invite, now with this role). 409 if that account already has access |
| PUT | `/v1/apps/:name/collaborators/:accountId` | **owner or admin**: `{role}` |
| DELETE | `/v1/apps/:name/collaborators/:accountId` | **owner or admin**: remove one. Your own id: leave the app (any role; needs an `admin` token covering the app) |
| DELETE | `/v1/apps/:name/invites/:id` | **owner or admin**: cancel a pending invite |
| GET | `/v1/me/invites` | token with `read` or more over the whole account (not limited to some apps): invites to this account's email (live apps) → `{invites: [{id, app, email, role, invitedBy, createdAt}]}` |
| POST | `/v1/me/invites/:id/accept` | full-access token: become a collaborator → `{app}` (with `access`) |
| DELETE | `/v1/me/invites/:id` | full-access token: decline |
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
| POST | `/v1/apps/:name/domains` | `{domain}` → pending (403 `custom_domains_disabled` when the server has them off: `customDomains: false` in `GET /v1`); `dns` lists the CNAME to point at the app and the TXT `_cresslet.<domain>` proving ownership. Max 10 |
| POST | `/v1/apps/:name/domains/:domain/verify` | checks the TXT record; first app to verify a domain gets it (409 after). 403 `custom_domains_disabled` when off |
| DELETE | `/v1/apps/:name/domains/:domain` | |
| GET | `/v1/domains/check?domain=` | 200 if it's a verified custom domain, else 404. For on-demand TLS (the root and app subdomains use the wildcard cert) |
| GET | `/v1/apps/:name/db?limit=100` | `{tables: {name: {schema, count, rows, truncated?}}, truncated?}` (limit ≤ 1000 rows per table; same 4 MiB / 5 s caps as `db/query`) |
| POST | `/v1/apps/:name/db/query` | `{sql, params?}` read-only → `{rows, truncated?}`: at most 1000 rows and 4 MiB per reply; stopped after 5 s (`504 query_timeout`); `429 busy` past 2 running per app, 4 in all |
| GET | `/v1/me/settings` | `{pages: {visibility, retentionDays}, defaults: {pages}}`: the account's defaults for new [pages](#pages) (falling back to the server's), and the server's |
| PUT | `/v1/me/settings` | full-access token: `{pages: {visibility?, retentionDays?}}` (keys left out keep their value) or `{pages: null}` (back to the server's) |
| GET | `/v1/pages` | pages the account owns or collaborates on (each with `access`; expired ones left out) → `{pages, defaults}` |
| POST | `/v1/pages` | `deploy` token over the whole account: `{html}` or `{files}`, `title?`, `visibility?`, `retentionDays?` → `{page}` (201) |
| GET | `/v1/pages/:name` | `{page}` |
| PUT | `/v1/pages/:name` | owner or admin (`deploy`): `{html}` or `{files}` → same URL, new files; restarts the retention clock |
| PATCH | `/v1/pages/:name` | owner or admin: `{title?, visibility?, retentionDays?}`; a new `retentionDays` counts from now |
| DELETE | `/v1/pages/:name` | owner: delete it and its files |
| POST | `/v1/pages/:name/view` | any access, logged in: `{path?}` → `{url, expiresIn}`: opens the page in a browser (private pages: a one-time sign-in link, valid `expiresIn` seconds) |
| GET | `/v1/admin/sites` | **site admin**: every site (deleted too) → `{totals, retentionDays, sites: [{name, url, status: running\|idle\|empty\|deleted, owner, domains, currentDeploy, usage: {deploys, database, files, total} (bytes on disk), deletedAt, purgeAt, …}]}` |
| GET | `/v1/admin/sites/:name` | **site admin**: `{site, deploys, domains, secrets (count), database: {tables: [{name, rows}]}, runtime}`. `database` is null unless the caller owns the site or is one of its admins |
| DELETE | `/v1/admin/sites/:name` | **site admin**: soft delete. Offline at once (not served, no crons, 404 to its owner, name stays taken) and restorable until purged after `CRESSLET_DELETED_RETENTION_DAYS`. `?purge=1` deletes it and its data permanently now |
| POST | `/v1/admin/sites/:name/restore` | **site admin**: undo a soft delete |
| PUT | `/v1/admin/accounts/role` | **site admin**: `{email, role: "SiteAdmin" \| null}` grant/revoke (not your own) |

## Pages

Static HTML you upload and share, like an artifact: one file (`{"html": "…"}`, served as `index.html`) or a folder (`{"files": [{path, data, encoding}]}` with an `index.html` at the root; same size limits as deploys). No server, crons, secrets or domains: the `/v1/apps` endpoints for those answer 409 `is_page`. Each page gets an unguessable name (`pg-<20 hex>`) and its own origin, `pg-….<domain>`, so its scripts can't read another page's or the studio's storage.

`visibility`:
- `private`: only its owner and [collaborators](#http-api-v1) (any role), logged in. A visitor without a session is sent to the studio (`/#/view/<name>?path=…`), which calls `POST /v1/pages/:name/view` and sends them back with a one-time ticket (`?cresslet_view=…`, 2 minutes). The page's host swaps it for an HttpOnly session cookie for that host only (`__Host-cresslet_page` on https, 24 h) and drops it from the URL. Each request checks that the account still has access, so removing a collaborator takes effect at once. Responses are `cache-control: private, no-store`.
- `link`: anyone with the URL. `x-robots-tag: noindex, nofollow` and `referrer-policy: no-referrer` (the URL doesn't leak to the sites it links to).
- `public`: anyone; search engines may index it.

`retentionDays`: whole days from 1 to 3650, or `null` = keep forever. The page expires that many days after its last upload or retention change (`expiresAt`), then it's gone (404 at once; files purged within ~10 minutes).

Defaults for a new page, in order: the upload's own fields, the account's (`PUT /v1/me/settings`), the server's (`CRESSLET_PAGE_VISIBILITY`, default `private`; `CRESSLET_PAGE_RETENTION_DAYS`, default 30). Every page can be changed later with `PATCH`.

Sharing a private page: invite accounts with `POST /v1/apps/<page>/collaborators` (viewers can open it; admins can also change and re-upload it). Pages count toward `CRESSLET_MAX_PAGES_PER_ACCOUNT` (default 200), not the app limit, and aren't in `GET /v1/apps`.

```sh
curl -X POST $CRESSLET/v1/pages -H "authorization: Bearer $CRESSLET_TOKEN" -H "content-type: application/json" \
  -d '{"html":"<h1>Report</h1>","visibility":"link","retentionDays":7}'
# → {"page":{"name":"pg-…","url":"https://pg-….example.com","visibility":"link","retentionDays":7,"expiresAt":"…",…}}
```

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
