# HTTP API (v1)

Base: `http://localhost:8787` (self-hosted default). JSON in/out. CORS `*`.

Auth (either):
- `Authorization: Bearer clv_acct_…` (or `clv_scoped_…`) — account token (GitHub login, or created in the studio under Settings → API tokens).
- `X-Cresslet-Deploy-Key: clv_app_…` (or `Authorization: Bearer clv_app_…`) — per-app key, returned once on app creation.

Site admin = an account with the `SiteAdmin` role (or listed in `CRESSLET_SITE_ADMINS`) using a full-access token (`admin`, all apps), or the operator's `CRESSLET_ADMIN_TOKEN`. The studio shows them an **Admin** page (`/#/admin`), **Users** (`/#/admin-users`) and **Organizations** (`/#/admin-orgs`), and, with AI credits on, an **AI credits** page (`/#/admin-credits`): use per day, model and account, and giving or taking back credits.

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

**Accounts (site admins).** Site admins list every account (`/#/admin-users` in the studio), invite people, disable accounts and grant the `SiteAdmin` role:
- **Invite**: sets up an account for an email (status `invited`). The person signs in with GitHub; any verified email on their GitHub account that matches links it, also while signup is closed (`CRESSLET_OPEN_SIGNUP=false`). No email is sent. An invite can be withdrawn (the account deleted) until they sign in. Optionally adds them to an [organization](#organizations).
- **Disable**: signs the account out everywhere (tokens and private-page sessions deleted), refuses its GitHub login (by GitHub id or any of its verified emails), its tokens, and deploys with its personal apps' deploy keys. Its sites keep serving: delete them on the Sites page. Its email and GitHub id are moved aside while it's disabled (`email` reads `disabled+<id>@invalid` in the database), so a server from before this release, after a rollback, can't sign it in either. **Enable** puts them back (409 if another account took that email or GitHub id meanwhile).
- You can't disable or demote yourself, nor an account listed in `CRESSLET_SITE_ADMINS` (change the config).

<a id="organizations"></a>
**Organizations.** Site admins create organizations (`/#/admin-orgs`) and pick a first admin. Org admins add and remove members (existing accounts, by email: only site admins invite new people) and change roles; an organization keeps at least one enabled admin unless a site admin changes it. An app or artifact moved into an organization (`PUT /v1/apps/:name/org`, by its owner, who must be a member) belongs to it:
- org `admin`: owner access to every org app (delete, move out, everything).
- org `member`: collaborator `admin` access to every org app (deploy, roll back, secrets, domains, sharing; not deleting).
- A collaborator role on the app adds to that; the app's `account_id` (who created it or last held it) no longer counts on its own. Members who leave or are removed (or disabled) lose access, and the apps they held are handed to an enabled org admin, so a rolled-back server (which ignores organizations and treats `account_id` as the owner) keeps them with the org. Org apps don't count toward anyone's app limit; moving one out makes it the caller's personal app, within their limit.
- Site admins manage organizations but get no access to their apps unless they're members. An organization with apps (deleted ones included) can't be deleted: move them out first.
- Not covered: deploy keys stay valid when an app changes hands (whoever holds the key keeps full access to that app); collaborators stay too.

Creating apps, claiming apps and managing tokens (`/v1/me/tokens`, `/v1/me/token`) need `admin` over all apps. Tokens issued before named tokens, and login tokens, are `admin` over all apps. `GET /v1/me` works with any token. Deploy keys (`clv_app_…`) are unchanged: full access to their one app.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1` | server info, limits, app URL template, `customDomains` (whether apps can add custom domains), `auth: {github, cli}` (`cli`: the browser login below), `ai: {credits, monthlyCredits}` ([AI credits](#ai-credits)) |
| POST | `/v1/accounts` | **admin token only**: `{email}` → `{account, token}`. Pre-create an account (GitHub login with that verified email links to it). 409 `account_disabled` for a disabled account's email |
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
| GET | `/v1/names?kind=app\|page` | no auth: a free generated [name](#names) for a new app (`amber-comet-1a2b`) or artifact (`pg-<20 hex>`) → `{name, url}` |
| GET | `/v1/names/:name` | no auth: can a new app or artifact have this name? → `{name, available: true, url}` or `{name, available: false, reason: invalid\|reserved\|taken, message}` |
| GET | `/v1/templates/:name` | `{files: [{path, data, encoding: utf8\|base64}]}` |
| POST | `/v1/deploys` | see below |
| GET | `/v1/apps` | apps the account owns, collaborates on or reaches through an [organization](#organizations); each has `access: owner\|admin\|viewer` and `org: {name, title} \| null` |
| GET | `/v1/apps/:name` | app (with the caller's `access`, null for a deploy key), last 10 deploys, runtime status, secret names |
| DELETE | `/v1/apps/:name` | delete app + data (owner or deploy key; not an invited admin) |
| PUT | `/v1/apps/:name/org` | owner (org app: an org admin), full-access token: `{org: "name" \| null}` → `{app, org}`. Into an organization you're a member of, or out of one (`null`: your personal app, within your app limit) |
| GET | `/v1/apps/:name/collaborators` | **owner or admin**: `{owner: {id, email, github} \| null, org: {name, title} \| null, collaborators: [{id, email, github, role, createdAt}], invites: [{id, email, role, invitedBy, createdAt}]}` |
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
| GET | `/v1/apps/:name/metrics` | the dashboard's numbers: `{since, bucketMs, totals: {requests, errors, clientErrors, avgMs, maxMs}, series: [{t, requests, errors, avgMs}], usage: {deploys, database, files, total}, database: {tables: [{name, rows}], error}, domains}`. Requests are counted in memory over the last 24 h in 5-minute buckets (`since`: when counting started, at server start); `avgMs`/`maxMs` time server routes only |
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
| GET | `/v1/me/settings` | `{pages: {visibility, retentionDays}, defaults: {pages}}`: the account's defaults for new [artifacts](#artifacts) (falling back to the server's), and the server's |
| PUT | `/v1/me/settings` | full-access token: `{pages: {visibility?, retentionDays?}}` (keys left out keep their value) or `{pages: null}` (back to the server's) |
| GET | `/v1/pages` | [artifacts](#artifacts) the account owns or collaborates on (each with `access`; expired ones left out) → `{pages, defaults}` |
| POST | `/v1/pages` | `deploy` token over the whole account: `{html}` or `{files}`, `name?`, `title?`, `visibility?`, `retentionDays?` → `{page}` (201). `name` left out: a generated unguessable one. 409 if taken, 400 `invalid_name` |
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
| GET | `/v1/admin/accounts` | **site admin**: `{totals: {accounts, active, invited, disabled, siteAdmins}, openSignup, accounts: [{id, email, github, status: active\|invited\|disabled, siteAdmin, siteAdminFromConfig, apps, orgs: [{name, title, role}], invitedBy, createdAt, lastActiveAt, disabledAt}]}` (`apps`: personal apps and artifacts; `lastActiveAt`: a token's last use) |
| POST | `/v1/admin/accounts` | **site admin**: invite `{email, siteAdmin?, org?, orgRole?: member\|admin}` → `{account}` (201). 409 if the email has an account |
| PATCH | `/v1/admin/accounts/:id` | **site admin**: `{siteAdmin?: bool, disabled?: bool}` → `{account}`. 400 for yourself, 400 `config_admin` for one in `CRESSLET_SITE_ADMINS` |
| DELETE | `/v1/admin/accounts/:id` | **site admin**: withdraw an invite (deletes an `invited` account that owns nothing); 409 `not_invited` otherwise |
| GET | `/v1/orgs` | token with `read` or more over the whole account: `{orgs: [{id, name, title, createdAt, role}]}` you belong to |
| GET | `/v1/orgs/:org` | members and site admins: `{org, role, canManage, members: [{id, email, github, role, disabled, createdAt}], apps: [{name, kind, url, updatedAt}]}`; 404 to others |
| POST | `/v1/orgs/:org/members` | org admin (full-access token) or site admin: `{email, role?: member\|admin}` → `{member}` (201). 404 `no_account` if no account has that email, 409 if already a member. At most 500 |
| PUT | `/v1/orgs/:org/members/:accountId` | org admin or site admin: `{role}`. 400 `last_admin` demoting the last enabled admin (not for site admins) |
| DELETE | `/v1/orgs/:org/members/:accountId` | org admin or site admin; your own id: leave (full-access token). 400 `last_admin` as above. The apps they held go to an enabled org admin |
| GET | `/v1/admin/orgs` | **site admin**: `{orgs: [{id, name, title, createdAt, members, apps}]}` |
| POST | `/v1/admin/orgs` | **site admin**: `{name, title?, admin?: email}` → `{org}` (201). `name`: 1-40 of a-z, 0-9, single dashes. 404 `no_account` for an unknown admin email, 409 if taken |
| DELETE | `/v1/admin/orgs/:org` | **site admin**: delete an empty organization; 409 `not_empty` while it has apps or artifacts |
| GET | `/v1/me/credits` | token with `read` or more over the whole account: `{enabled: false}`, or `{enabled: true, available, balance, monthly: {allowance, used, remaining, resetsAt}, creditsPerUsd, history: [{at, kind: usage\|grant, credits, model?, inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, estimated?, note?}]}` (last 50) |
| POST | `/v1/ai/v1/messages` | `deploy` token over the whole account: a streamed Anthropic Messages request, on [AI credits](#ai-credits) |
| POST | `/v1/admin/accounts/credits` | **site admin**: `{email, credits, note?}` adds credits to the account (negative: takes some back) → `{account, balance}`. 409 `ai_disabled` without AI credits |
| GET | `/v1/admin/credits` | **site admin**: `{enabled: false}`, or `{enabled: true, creditsPerUsd, monthlyCredits, period, resetsAt, totals: {used, free, usd, requests, granted, grants, balance, overdrawn, accounts, active}, days: [{date, credits, requests}] (last 30, UTC), models: [{model, credits, requests, usd, inputTokens, outputTokens}], accounts: [{id, email, github, available, balance, monthlyUsed, used, requests, lastUsedAt}], recent: [ledger row + {account}]}`. `totals.used/free/usd/requests/granted/grants/active`, `models`, and each account's `used` and `requests` are this month (UTC); `totals.balance`/`overdrawn` are granted credits held / owed across all wallets now, `totals.accounts` counts every wallet; `accounts` lists every account that has used or been given credits, most used first; `recent` is the last 50 rows, which also carry `usd` and `free` (usage) or `by` (grants) |
| GET | `/v1/admin/credits/accounts/:id` | **site admin**: one account: `{enabled, monthlyCredits, resetsAt, account: {id, email, github, siteAdmin, available, balance, monthlyUsed, used, requests, lastUsedAt}, history}` (last 200 ledger rows), or `{enabled: false}` without AI credits. 404 for an unknown id |

<a id="pages"></a>

## Artifacts

An artifact is static HTML you share (called a page in the API: `/v1/pages`, `kind: "page"`, the `page` and `pages` keys): one file (`{"html": "…"}`, served as `index.html`) or a folder (`{"files": [{path, data, encoding}]}` with an `index.html` at the root; same size limits as deploys). No server, crons, secrets or domains: the `/v1/apps` endpoints for those answer 409 `is_page`. Each artifact gets an unguessable name (`pg-<20 hex>`), or the `name` you upload it with, and its own origin, `pg-….<domain>`, so its scripts can't read another artifact's or the studio's storage.

App or artifact? An app is software that runs: an optional server with a database, files, secrets and crons, always public, with the last 10 deploys kept for rollback. An artifact is a finished file or folder you hand to people: who can open it and how long it's kept are up to you, and it keeps only the version it serves. The CLI's `cresslet deploy` makes one or the other: a project (`cresslet.json`) or any other folder is an app; a single `.html` file, or a folder with `--artifact` (or `--visibility` / `--keep` / `--title`), is an artifact, and deploying the same file or folder again updates it (`PUT /v1/pages/:name`). `--name` picks its address.

A name you choose can be guessed: keep the generated one for a `link` artifact that only the people you send it to should open.

`visibility`:
- `private`: only its owner and [collaborators](#http-api-v1) (any role), logged in. A visitor without a session is sent to the studio (`/#/view/<name>?path=…`), which calls `POST /v1/pages/:name/view` and sends them back with a one-time ticket (`?cresslet_view=…`, 2 minutes). The page's host swaps it for an HttpOnly session cookie for that host only (`__Host-cresslet_page` on https, 24 h) and drops it from the URL. Each request checks that the account still has access, so removing a collaborator takes effect at once. Responses are `cache-control: private, no-store`.
- `link`: anyone with the URL. `x-robots-tag: noindex, nofollow` and `referrer-policy: no-referrer` (the URL doesn't leak to the sites it links to).
- `public`: anyone; search engines may index it.

`retentionDays`: whole days from 1 to 3650, or `null` = keep forever. The page expires that many days after its last upload or retention change (`expiresAt`), then it's gone (404 at once; files purged within ~10 minutes).

Defaults for a new artifact, in order: the upload's own fields, the account's (`PUT /v1/me/settings`), the server's (`CRESSLET_PAGE_VISIBILITY`, default `private`; `CRESSLET_PAGE_RETENTION_DAYS`, default 30). Every artifact can be changed later with `PATCH`.

Sharing a private artifact: invite accounts with `POST /v1/apps/<page>/collaborators` (viewers can open it; admins can also change and re-upload it). Artifacts count toward `CRESSLET_MAX_PAGES_PER_ACCOUNT` (default 200), not the app limit, and aren't in `GET /v1/apps`. An artifact keeps only the version it serves: re-uploading replaces the files, with no history or rollback (the replaced files are removed a minute or more later, or sooner when more than 3 versions pile up).

```sh
curl -X POST $CRESSLET/v1/pages -H "authorization: Bearer $CRESSLET_TOKEN" -H "content-type: application/json" \
  -d '{"html":"<h1>Report</h1>","visibility":"link","retentionDays":7}'
# → {"page":{"name":"pg-…","url":"https://pg-….example.com","visibility":"link","retentionDays":7,"expiresAt":"…",…}}
```

## AI credits

With `CRESSLET_ANTHROPIC_API_KEY` set ([self-hosting](self-hosting.md#configuration)), the studio's AI builder calls Claude through the server instead of with each user's own Anthropic key: `POST /v1/ai/v1/messages` takes an [Anthropic Messages](https://platform.claude.com/docs/en/api/messages) request, sends it with the operator's key, streams the reply back unchanged, and charges the account for the tokens the reply used. An Anthropic SDK points at it with `baseURL: "<server>/v1/ai"` and the Cresslet token as `authToken` (it never reaches Anthropic).

- **Price**: Anthropic's list price for the model that answered (cache reads and writes included; every attempt of a server-side fallback), × `CRESSLET_AI_CREDITS_PER_USD` (default 100: a credit is a cent at cost). Rounded up to a thousandth of a credit.
- **Where credits come from**: `CRESSLET_AI_MONTHLY_CREDITS` free each calendar month (UTC; used first, unused ones don't carry over), then credits a site admin grants (`POST /v1/admin/accounts/credits`). A request needs some left (else 402 `credits_exhausted`); the request that crosses zero is charged in full, so the balance can end slightly below 0. At most `CRESSLET_AI_MAX_CONCURRENT` requests per account at once (429), which bounds that.
- **What can be sent**: streamed requests (`stream: true`) for a listed Claude model, with `max_tokens` up to 128000, client tools only (no server tools such as web search), `output_config` `effort`/`format`, and the `server-side-fallback-2026-07-01` beta. Anything else is a 400 before it reaches Anthropic. Errors use the Messages API shape (`{type: "error", error: {type, message}}`).
- **A reply the client stops** is still read to its end and charged for what Claude generated; one cut off upstream is charged for what streamed, with the output estimated (`estimated: true` in the history).

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

- `app` omitted → random name. `app` unknown → created with that name. `app` exists → needs auth, or 409 with `"create": true` (create only).
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

## Names

A new app or artifact is served at `<name>.<domain>`. Names are 1-40 characters of `a-z`, `0-9` and single dashes, not starting or ending with a dash, and not a reserved word (`www`, `api`, `studio`, `admin`, `app`, `apps`, `docs`, `status`, `mail`, `preview`). Apps and artifacts share one namespace, and a deleted app's name stays taken until it's purged. The name is fixed once created.

The studio asks for one before an app's first deploy and on the artifact form: it starts from `GET /v1/names?kind=…` and checks each edit with `GET /v1/names/:name` (both 120 per minute per address). The check is advisory: `POST /v1/deploys` and `POST /v1/pages` still answer 409 if someone took the name in between (for an app, when the deploy says `"create": true`: without it, a name taken by one of your own apps is a deploy to that app).

## Minimal agent deploy (no CLI)

```sh
curl -s localhost:8787/v1/deploys -H 'content-type: application/json' \
  -d '{"files":[{"path":"index.html","data":"<h1>hello</h1>"}]}'
```
