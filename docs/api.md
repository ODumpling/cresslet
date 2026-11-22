# HTTP API (v1)

Base: `http://localhost:8787` (self-hosted default). JSON in/out. CORS `*`.

Auth (either):
- `Authorization: Bearer clv_acct_…` (or `clv_scoped_…`) — account token (GitHub login, or created in the studio under Settings → API tokens).
- `X-Cresslet-Deploy-Key: clv_app_…` (or `Authorization: Bearer clv_app_…`) — per-app key, returned once on app creation.

Site admin = an account with the `SiteAdmin` role (or listed in `CRESSLET_SITE_ADMINS`) using a full-access token (`admin`, all apps), or the operator's `CRESSLET_ADMIN_TOKEN`. The studio shows them an **Admin** page (`/admin`), **Users** (`/admin-users`) and **Organizations** (`/admin-orgs`), and, with AI credits on, an **AI credits** page (`/admin-credits`): use per day, model and account, and giving or taking back credits.

Errors: `{ "error": "<code>", "message": "…" }` with 4xx/5xx.

Account tokens have a **role** and optionally a list of **apps** (403 `forbidden` outside them):
- `read`: `GET` endpoints of the account's apps (app, logs, source, secret names, egress, domains, db) and `POST /apps/:name/db/query` (read-only).
- `deploy`: `read`, plus `POST /deploys` (existing apps), `POST /apps/:name/rollback` and the cron controls (`POST /apps/:name/crons/run|pause|resume`). Deployed code can read the app's secrets, so treat it as close to `admin` for that app.
- `admin`: everything on the apps (secrets, egress, domains, delete).
- `apps`: limit the token to these apps (by id: a deleted app doesn't come back into scope if its name is reused). Without it, the token covers every app, including new ones.

**Collaborators.** An app has one owner (the account that created it). The owner and the app's admins invite other accounts by email, as `admin` or `viewer`. An invite is pending until the account with that email (shown in its Settings; matched case-insensitively) accepts it with `POST /v1/me/invites/:id/accept`; no email is sent, and inviting an address with no account yet works the same, so it doesn't tell you whether one exists. Access is the collaborator's role, capped by the calling token's role and apps:
- `viewer`: what a `read` token can do (app, logs, source, secret names, egress, domains, db, `db/query`).
- `admin`: everything on the app, including deploys, secrets, egress, domains and managing collaborators, but not deleting it (owner only).
- Managing collaborators needs an account (a deploy key isn't one). Shared apps are listed in `GET /v1/apps` with `access: owner|admin|viewer`, can be named in a token's `apps`, and don't count toward the invitee's app limit. At most 50 collaborators and pending invites per app. Deleting the app removes them.

**Accounts (site admins).** Site admins list every account (`/admin-users` in the studio), invite people, disable accounts and grant the `SiteAdmin` role:
- **Invite**: sets up an account for an email (status `invited`). The person signs in with GitHub; any verified email on their GitHub account that matches links it, also while signup is closed (`CRESSLET_OPEN_SIGNUP=false`). No email is sent. An invite can be withdrawn (the account deleted) until they sign in. Optionally adds them to an [organization](#organizations).
- **Disable**: signs the account out everywhere (tokens and private-page sessions deleted), refuses its GitHub login (by GitHub id or any of its verified emails), its tokens, and deploys with its personal apps' deploy keys. Its sites keep serving: delete them on the Sites page. Its email and GitHub id are moved aside while it's disabled (`email` reads `disabled+<id>@invalid` in the database), so a server from before this release, after a rollback, can't sign it in either. **Enable** puts them back (409 if another account took that email or GitHub id meanwhile).
- You can't disable or demote yourself, nor an account listed in `CRESSLET_SITE_ADMINS` (change the config).

<a id="organizations"></a>
**Organizations.** Site admins create organizations (`/admin-orgs`) and pick a first admin. Org admins add and remove members (existing accounts, by email: only site admins invite new people) and change roles; an organization keeps at least one enabled admin (site admins too: promote another first). Disabling an org's only admin is allowed; until a site admin makes someone else admin, no app moves in and nobody holding its apps can leave. An app or artifact moved into an organization (`PUT /v1/apps/:name/org`, by its owner, who must be a member) belongs to it:
- org `admin`: owner access to every org app (delete, move out, everything).
- org `member`: collaborator `admin` access to every org app (deploy, roll back, secrets, domains, sharing; not deleting).
- A collaborator role on the app adds to that; the app's `account_id` (who created it or last held it) no longer counts on its own. Members who leave or are removed (or disabled) lose access, and the apps they held are handed to an enabled org admin (else member), so a rolled-back server (which ignores organizations and treats `account_id` as the owner) keeps them with the org. Org apps don't count toward anyone's app limit; moving one out makes it the caller's personal app, within their limit.
- Site admins manage organizations but get no access to their apps unless they're members. An organization with apps (deleted ones included) can't be deleted: move them out first (a deleted one: restore it, or purge it on the Sites page). A member who holds org apps can't be removed while there's nobody (enabled) to hand them to (409 `no_successor`), and apps can't move into an organization with no enabled admin (409 `no_admin`).
- Not covered: deploy keys stay valid when an app changes hands (whoever holds the key keeps full access to that app); collaborators stay too.

Creating apps and managing tokens (`/v1/me/tokens`, `/v1/me/token`) need `admin` over all apps. Tokens issued before named tokens, and login tokens, are `admin` over all apps. `GET /v1/me` works with any token. Deploy keys (`clv_app_…`) are unchanged: full access to their one app.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1` | server info, limits, app URL template, `customDomains` (whether apps can add custom domains), `auth: {github, cli}` (`cli`: the browser login below), `ai: {credits, monthlyCredits}` ([AI credits](#ai-credits)), `git: {github}` ([source control](#source-control)) |
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
| POST | `/v1/auth/cli` | CLI browser login: → `{deviceCode, userCode, verificationUri, expiresIn, interval}`; open `verificationUri` (the studio's `/cli`) and show `userCode`, which the user types there. 20 per client per 10 min |
| POST | `/v1/auth/cli/approve` | full-access account token (the studio) + `{userCode}` (case, dashes ignored) → `{approved: true}`; 404 if unknown, expired or already approved. 10 tries per account per 10 min |
| POST | `/v1/auth/cli/token` | `{deviceCode}` → `{status: pending}` or `{status: complete, account, token}` (a new token, once); 400 `expired_token` after, or if the approving token was revoked. Poll every `interval`s |
| GET | `/v1/templates` | `{templates: [{name, description}]}` |
| GET | `/v1/names?kind=app\|page` | no auth: a free generated [name](#names) for a new app (`amber-comet-1a2b`) or artifact (`pg-<20 hex>`) → `{name, url}` |
| GET | `/v1/names/:name` | no auth: can a new app or artifact have this name? → `{name, available: true, url}` or `{name, available: false, reason: invalid\|reserved\|taken, message}` |
| GET | `/v1/templates/:name` | `{files: [{path, data, encoding: utf8\|base64}]}` |
| POST | `/v1/deploys` | see below |
| POST | `/v1/apps` | full-access token: `{name}` → `{app}` (201): a new app with nothing deployed yet, its address reserved (the studio links a repository before the first deploy). Same name rules, limits and 409 as a deploy that creates one |
| GET | `/v1/apps` | apps the account owns, collaborates on or reaches through an [organization](#organizations); each has `access: owner\|admin\|viewer` and `org: {name, title} \| null` |
| GET | `/v1/apps/:name` | app (with the caller's `access`, null for a deploy key), last 5 deploys (each with `hasSource`: the project source came with it, and `git: {sha, branch, repo, url} \| null`, `url`: the commit on GitHub), runtime status, secret names, `repo` (the linked [repository](#source-control) or null) |
| DELETE | `/v1/apps/:name?id=` | delete app + data (owner or deploy key; not an invited admin). `id` (optional): only if it's still that app, else 409 `conflict` |
| PUT | `/v1/apps/:name/org` | owner (org app: an org admin), full-access token: `{org: "name" \| null}` → `{app, org}`. Into an organization you're a member of, or out of one (`null`: your personal app, within your app limit) |
| GET | `/v1/apps/:name/collaborators` | **owner or admin**: `{owner: {id, email, github} \| null, org: {name, title} \| null, collaborators: [{id, email, github, role, createdAt}], invites: [{id, email, role, invitedBy, createdAt}]}` |
| POST | `/v1/apps/:name/collaborators` | **owner or admin**: `{email, role?: viewer\|admin (default viewer)}` → `{invite}` (201; 200 if that email had a pending invite, now with this role). 409 if that account already has access |
| PUT | `/v1/apps/:name/collaborators/:accountId` | **owner or admin**: `{role}` |
| DELETE | `/v1/apps/:name/collaborators/:accountId` | **owner or admin**: remove one. Your own id: leave the app (any role; needs an `admin` token covering the app) |
| DELETE | `/v1/apps/:name/invites/:id` | **owner or admin**: cancel a pending invite |
| GET | `/v1/me/invites` | token with `read` or more over the whole account (not limited to some apps): invites to this account's email (live apps) → `{invites: [{id, app, email, role, invitedBy, createdAt}]}` |
| POST | `/v1/me/invites/:id/accept` | full-access token: become a collaborator → `{app}` (with `access`) |
| DELETE | `/v1/me/invites/:id` | full-access token: decline |
| POST | `/v1/apps/:name/rollback` | `{deployId?}` (default: previous) |
| GET | `/v1/apps/:name/source?deploy=` | `{app, deployId, files: [{path, data, encoding}]}` source uploaded with the current (or given) deploy; 404 `no_source` if none |
| GET | `/v1/apps/:name/metrics` | the dashboard's numbers: `{since, bucketMs, totals: {requests, errors, clientErrors, avgMs, maxMs}, series: [{t, requests, errors, avgMs}], usage: {deploys, database, files, total}, database: {tables: [{name, rows}], error}, domains}`. Requests are counted in memory over the last 24 h in 5-minute buckets (`since`: when counting started, at server start); `avgMs`/`maxMs` time server routes only |
| GET | `/v1/apps/:name/logs?n=200&follow=1` | NDJSON `{t, kind: stdout\|stderr\|system\|request, msg}`; `follow` streams |
| GET | `/v1/apps/:name/crons` | `{crons: [{cron, paused, state: running\|queued\|null, next: [iso, …≤3], last}], runs: [{cron, at, startedAt, ms, status, ok, manual}], since}`: the current deploy's crons, the next times each fires (none while paused), each one's last run, and the last 50 runs, kept in memory since `since` (server start). `status` 0: the app couldn't be reached |
| POST | `/v1/apps/:name/crons/run` | `deploy`: `{cron}` (as in the config) → 202 with the view above. Queues one run behind the app's others, also of a paused cron; 409 `busy` if it's already running or queued. While it's queued, the cron's scheduled runs are skipped, as for any run still going. Claimed apps only |
| POST | `/v1/apps/:name/crons/pause` | `deploy`: `{cron}` → the view above. Stops its scheduled runs until resumed (stored by expression: it stays paused across deploys and rollbacks that keep the expression; one without it forgets the pause) |
| POST | `/v1/apps/:name/crons/resume` | `deploy`: `{cron}` → the view above |
| GET | `/v1/apps/:name/secrets` | `{keys}` (values are write-only) |
| PUT | `/v1/apps/:name/secrets` | `{KEY: "value" \| null}` merge |
| DELETE | `/v1/apps/:name/secrets/:key` | |
| GET | `/v1/apps/:name/egress` | `{allow}`: hostnames the server may `fetch`, or `null` = any public host |
| PUT | `/v1/apps/:name/egress` | `{allow: ["api.stripe.com", "*.openai.com"] \| null}` (≤ 50; `*.` = subdomains only). Blocked requests get 403 and a log line; raw sockets are refused under an allowlist |
| GET | `/v1/apps/:name/domains` | `{domains: [{domain, verified, dns: [{type, name, value}]}]}` |
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
| DELETE | `/v1/admin/accounts/:id` | **site admin**: withdraw an invite (deletes an `invited` account that owns nothing); 409 `not_invited` otherwise, 409 `last_admin` while it's an organization's only admin |
| GET | `/v1/orgs` | token with `read` or more over the whole account: `{orgs: [{id, name, title, createdAt, role}]}` you belong to |
| GET | `/v1/orgs/:org` | members and site admins: `{org, role, canManage, members: [{id, email, github, role, disabled, createdAt}], apps: [{name, kind, url, updatedAt}]}`; 404 to others |
| POST | `/v1/orgs/:org/members` | org admin (full-access token) or site admin: `{email, role?: member\|admin}` → `{member}` (201). 404 `no_account` if no account has that email, 409 if already a member. At most 500 |
| PUT | `/v1/orgs/:org/members/:accountId` | org admin or site admin: `{role}`. 400 `last_admin` demoting the last enabled admin |
| DELETE | `/v1/orgs/:org/members/:accountId` | org admin or site admin; your own id: leave (full-access token). 400 `last_admin` as above. The apps they held go to an enabled org admin |
| GET | `/v1/admin/orgs` | **site admin**: `{orgs: [{id, name, title, createdAt, members, apps}]}` |
| POST | `/v1/admin/orgs` | **site admin**: `{name, title?, admin: email}` → `{org}` (201); `admin`: its first admin, an existing account. `name`: 1-40 of a-z, 0-9, single dashes. 404 `no_account` for an unknown admin email, 409 if taken |
| DELETE | `/v1/admin/orgs/:org` | **site admin**: delete an empty organization; 409 `not_empty` while it has apps or artifacts |
| GET | `/v1/me/credits?offset=&limit=&upTo=` | token with `read` or more over the whole account: `{enabled: false}`, or `{enabled: true, available, balance, monthly: {allowance, used, remaining, resetsAt}, creditsPerUsd, history: [{at, kind: usage\|grant, credits, model?, inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, estimated?, note?}], historyTotal, historyUpTo}`. `history` is newest first: `limit` entries (default 50, at most 100) after skipping `offset` (default 0); `historyTotal` counts them all. Entries added later come after `historyUpTo`: pass it back as `upTo` and the next pages count from the same entry |
| POST | `/v1/ai/v1/messages` | `deploy` token over the whole account: a streamed Anthropic Messages request, on [AI credits](#ai-credits) |
| POST | `/v1/admin/accounts/credits` | **site admin**: `{email, credits, note?}` adds credits to the account (negative: takes some back) → `{account, balance}`. 409 `ai_disabled` without AI credits |
| GET | `/v1/admin/credits` | **site admin**: `{enabled: false}`, or `{enabled: true, creditsPerUsd, monthlyCredits, period, resetsAt, totals: {used, free, usd, requests, granted, grants, balance, overdrawn, accounts, active}, days: [{date, credits, requests}] (last 30, UTC), models: [{model, credits, requests, usd, inputTokens, outputTokens}], accounts: [{id, email, github, available, balance, monthlyUsed, used, requests, lastUsedAt}], recent: [ledger row + {account}]}`. `totals.used/free/usd/requests/granted/grants/active`, `models`, and each account's `used` and `requests` are this month (UTC); `totals.balance`/`overdrawn` are granted credits held / owed across all wallets now, `totals.accounts` counts every wallet; `accounts` lists every account that has used or been given credits, most used first; `recent` is the last 50 rows, which also carry `usd` and `free` (usage) or `by` (grants) |
| GET | `/v1/admin/credits/accounts/:id` | **site admin**: one account: `{enabled, monthlyCredits, resetsAt, account: {id, email, github, siteAdmin, available, balance, monthlyUsed, used, requests, lastUsedAt}, history}` (last 200 ledger rows), or `{enabled: false}` without AI credits. 404 for an unknown id |

<a id="source-control"></a>

## Source control

Apps can sync with a GitHub repository (when the server has it on: `git.github` in `GET /v1`; [self-hosting](self-hosting.md#source-control)). Cresslet calls GitHub as the signed-in user: each account connects its own GitHub, and every call below uses the calling account's token, never the app owner's (collaborators connect their own). Tokens never leave the server. Files go through the same filter as a deploy's `sources` (no local secrets: see [POST /v1/deploys](#post-v1deploys)); a dotenv file whose public entries are unchanged keeps the repository's copy.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/me/git` | `read` token over the account: `{provider: "github", available, kind: app\|oauth\|null, connected, login, status: active\|expired\|null, installUrl}` (`installUrl`: where the user picks which repositories the GitHub App reaches) |
| POST | `/v1/git/github/connect` | full-access token: `{returnTo?: "/studio/path"}` → `{url}`. Navigate the browser to `url` (GitHub's consent); it comes back to `returnTo` with `#cresslet_git=connected` or `#cresslet_git_error=…`. A state cookie binds the flow to that browser |
| DELETE | `/v1/me/git/github` | full-access token: forget the connection (and revoke the token on GitHub) |
| GET | `/v1/git/github/repos` | `{repos: [{id, owner, name, fullName, private, defaultBranch, url, push}]}`: up to 100 the user can push to, recently updated first |
| POST | `/v1/git/github/repos` | full-access token: `{name, owner?: org, private?: true}` → `{repo}` (201), created as the user with a first commit. 409 `repo_exists` |
| POST | `/v1/apps/:name/git/connect` | **owner or admin**: `{owner, repo, subdir?, deleteBranch?: true, initialSync: push\|pull\|deploy\|none, files?, message?}` → `{repo, sha, files?}` (201). `push`: commit `files` (the workspace) to the default branch; `deploy`: commit the source stored with the live deploy instead (an app deployed before it had a repository; 409 `no_source` if it was deployed without one); `pull`: its files back; `none`: just link. 403 `git_forbidden` if you can't push to it |
| DELETE | `/v1/apps/:name/git` | **owner or admin**: unlink (the repository is left alone) |
| GET | `/v1/apps/:name/git/status` | `{repo, defaultBranch, mainSha, branches: [{name, sha, protected}]}` |
| POST | `/v1/apps/:name/git/branches` | `deploy`: `{name, from?: sha}` → `{branch: {name, sha}}` (201), cut from the default branch's head by default. 409 `branch_exists` |
| GET | `/v1/apps/:name/git/tree?ref=` | `{ref, sha, files}`: the project's files at a branch (default: the default branch) or commit, under `subdir` |
| POST | `/v1/apps/:name/git/sync` | `deploy`: `{branch, baseSha, files, message?, mergeParent?}` → `{branch, sha, changed}`. `mergeParent`: a second parent (the default branch's head, its conflicts resolved: see `conflicts`). One commit making the branch hold exactly `files`. `baseSha`: the commit the workspace is on; 409 `conflict` with `headSha` if the branch moved since (nothing written). Never force-pushes. Onto a stack's top change from its recorded commit, the change follows the new commit; onto a change below its stack's top, 409 `not_on_top`; onto a change set aside, 409 `set_aside` |
| POST | `/v1/apps/:name/git/merge` | `deploy`: `{branch, into?, message?, headSha?}` (`headSha`: the commit the caller synced and will build; if the branch moved past it, 409 `conflict` and nothing is merged) → `{mergedSha, fastForward, treeChanged, branch, deletedBranch, files?, filesError?}`. Fast-forward when it can, else a merge commit. `treeChanged`: `into` had commits of its own, so `files` (the merged tree) come back to build from; if they can't be loaded (e.g. too many), it's still merged: `filesError` says why, and the branch is kept. 409 `merge_conflict` with `paths`; 422 `branch_protected` when `into` needs a pull request or checks. Afterwards the merged branch is deleted, best effort: not the default branch or `into`, not with `deleteBranch: false`, and only while it still points at the commit merged; `deletedBranch: true` means GitHub deleted it. Merging a stack's top change into the default branch lands its stack (`landed: {stack, changes, pullErrors?}`; `pullErrors`: branches kept because a pull request is still open on them, or another landing problem): change by change, as `…/git/stack/land` does, when the default branch takes direct moves and hasn't moved (a protected one: 422 `branch_protected`, Cresslet checks it itself, also when it can't read the protection: only admins can, and some users may bypass it; a change whose branch is gone: 404 `branch_not_found`); else as one merge, and the stack's branches go (same setting, the merged one included, while each still points at its change, not with `filesError`, and not one under a pull request still open: merged in one merge, the pull requests above the bottom can't be marked merged, so they're kept for closing on GitHub). A change below its stack's top can't be merged into the default branch on its own: 409 `not_on_top` (a change set aside: 409 `set_aside`) |
| GET | `/v1/apps/:name/git/stack` | the app's open [stacks](#stacked-changes), newest first: `{defaultBranch, stacks: [{id, name, baseSha, changes: [{id, position, branch, sha, baseSha, title, prompt, author, createdAt, github: ok\|moved\|gone, headSha?, pull}], setAside: [change…]}]}`, changes bottom first; `setAside`: changes gone back from, restorable. `github`: where the branch is on GitHub now (`moved`: not at `sha`, its head in `headSha`; `gone`: deleted) |
| POST | `/v1/apps/:name/git/stack` | `deploy`: `{from, baseSha, files, title?, prompt?}` → `{changed, sha, branch?, change?, stack?: {id, name}}` (201 when a change was made, else 200 and no branch). The workspace (`files`, on branch `from` at `baseSha`) committed as a new change: on the top change of an open stack it goes on top; on any other branch (the default one, a branch of its own) it starts a stack from `baseSha`. 409 `not_on_top` from a change below its stack's top, 409 `set_aside` from a change set aside, 409 `moved` from a top whose branch was pushed to on GitHub since (pull it in or carry on from it first; nothing written); 409 `not_on_stack` from a top change recorded at another commit than `baseSha` (commit with `sync` instead) |
| POST | `/v1/apps/:name/git/stack/submit` | `deploy`: `{stack}` → `{pulls: [{change, position, number?, url?, created?, merged?, error?}]}`. A pull request per open change, as the user: the bottom one into the default branch, each other one into the branch of the change below, titled after the change, its description the prompt and a table of the whole stack (this one marked). Safe to repeat: a change's pull request (recorded, or open from its branch) is reused, reopened if closed, pointed at the right base and given the change's title; one merged already is said (`merged`) and left alone; new changes get one; every table is refreshed (tables change only on submit: going back or restoring doesn't rewrite them). One GitHub refuses has `error`, and the others go on. Numbers are recorded on the stack (`pull`) |
| GET | `/v1/apps/:name/git/stack/pulls?stack=` | `{pulls: {<change id>: {number, url, title, draft, headSha, review, checks}}}`: the review and checks of a stack's pull requests |
| PATCH | `/v1/apps/:name/git` | **owner or admin**: `{stackAutoSubmit?: boolean}` → `{repo}`. `stackAutoSubmit` (off by default): after each new change, its stack is submitted, and `POST …/git/stack` answers with `submitted: {pulls, error?}` (not with `submit: false` in its body: a change made on the way to something else) |
| GET | `/v1/apps/:name/git/stack/undo?change=` | `deploy` → `{change, title, top: {branch, sha}, conflicts, files}`: undoing a change below its stack's top, keeping the later ones: the top merged with the change's parent, the change as the base, file by file (as `conflicts` does). Every file of the result under `subdir`; one later changes also touched where it did is in `conflicts`, both versions between `<<<<<<< now` / `=======` / `>>>>>>> undo change N` lines. The studio loads `files` on the top and commits them as a new change titled `title` ("Undo: <title>"), once no markers are left. 409 `top` for the top change (undo it by going back); 409 `merge_unresolvable` with `paths` for binary files both sides changed, or files the studio doesn't hold that the change touched (outside the app's folder, dotenv files), or a file where the result has a folder; 409 `moved` if a branch was pushed to on GitHub; 409 `undo_merge` if the change has a merge in it (the default branch merged in, a push pulled in: undoing it would undo that too); 409 `stack_full` at the stack's most changes |
| POST | `/v1/apps/:name/git/stack/fold` | `deploy`: `{change, into}` (`into`, required: the change below it the caller confirmed; another one there now: 409 `conflict`) → `{change, dropped, pullErrors?}`. Folds a change into the one below it (a small follow-up that doesn't need its own pull request): no commit changes (the chain is straight); the lower change leaves the stack and this one takes its place (its position, its base, its title, both prompts in its description); the ones above, set aside too, move down. Its pull request is pointed at the lower one's base first (refused: nothing changes). When the stack has pull requests, the remaining change's is opened or reopened if needed and the others' open ones refreshed (none opened for them), then the lower one's is closed with a comment pointing at it (only once the remaining one is open, on the right base) and its branch deleted. Kept, and said in `pullErrors`: the lower pull request while the remaining change has no open one (or GitHub won't close it), and the lower branch while a pull request is still on it, it moved, or GitHub won't delete it. 400 without `into`; 409 `conflict` when `into` isn't the change below it (also for the bottom change, which has none); 404 for one set aside or landed; 409 `moved` if either branch moved on GitHub |
| POST | `/v1/apps/:name/git/stack/land` | `deploy`: `{change}` → `{landed: [change…], sha, stack, deleted, pullErrors?}`. Lands that change and the ones below it, for a default branch that takes direct moves: one at a time, each change's pull request is pointed at the default branch and the default branch moved (fast-forward, never forced) to its commit, so each pull request shows as merged with only its own turn. Then the change above is the bottom (its pull request on the default branch; if GitHub refuses that, the branch below it is kept, said in `pullErrors`, so the pull request isn't closed) and the stack's landed branches go (the app's delete-branch setting, only while at their change; a branch GitHub deleted already is fine; one under a pull request still open, when the default branch moved past it outside Cresslet, is kept and said). Each step is recorded as it's done: a landing that stopped half way carries on when run again. Nothing is deployed. Refused before anything moves: 422 `branch_protected` (Cresslet checks the branch's protection and rulesets itself, first: protection needing reviews, checks, push restrictions or signed commits, a locked branch, protection or rules it can't read, or a blocking ruleset), 409 `default_moved` (the default branch has commits the stack doesn't: Deploy merges it in), 409 `moved` (a change pushed to on GitHub), 404 `branch_not_found` (a change's branch deleted on GitHub) |
| POST | `/v1/apps/:name/git/stack/pull-in` | `deploy`: `{change, sha}` (`sha`: its branch's head on GitHub, `headSha` when it `moved`) → `{change, dropped, pullErrors?}`. A change pushed to from outside the studio, pulled in as the top of its stack: it takes that commit, and the changes above it are set aside for good (they don't hold the push; branches kept, pull requests closed). 409 `conflict` if the branch isn't at `sha`, or isn't changed on GitHub any more |
| POST | `/v1/apps/:name/git/stack/carry-on` | `deploy`: `{change, sha}` → `{change, left}`. The other way: the stack ends, all its changes leave it (branches kept; those set aside can't be restored), and the workspace commits to that branch as one branch, as before stacks (`POST …/git/stack` from it: 409 `not_on_stack`) |
| GET | `/v1/apps/:name/git/stack/aside` | `{changes: [change… + {stackName, restorable}]}`: every change set aside, newest first (`restorable`: its stack is open and nothing was built where it was) |
| POST | `/v1/apps/:name/git/stack/aside/delete` | `deploy`: `{change}` → `{dropped, kept: [{change, position, error}]}`: deletes its branch and those of the changes set aside above it in its stack (the ones below stay restorable); a branch pushed to since is kept, and said |
| POST | `/v1/apps/:name/git/stack/back` | `deploy`: `{change, sha?, top?, topSha?}` (a change's id, the commit the caller will load, and the stack's top it expects) → `{change, stack: {id, name}, now, setAside: [change…]}`. Goes back to that change: the open changes above it in its stack are set aside (their branches kept, their pull requests closed: `pullErrors` lists any GitHub refused), so the next change goes on it. Load `change.sha` into the workspace (`tree?ref=`). `now`: the ids this set aside; `setAside`: all the stack's. 404 if it isn't an open change; 409 `conflict` if it isn't at `sha`, or the top isn't `top` at `topSha` |
| POST | `/v1/apps/:name/git/stack/restore` | `deploy`: `{stack, only?, top?, sha?}` → `{change, below, stack, restored}`: the stack's changes set aside (or only the ids in `only`, which must be the lowest of them: else 409 `conflict`) are back on it; `change` is its top again, `below` the top before; their pull requests are reopened (`pullErrors`). With `top`/`sha` (the change the caller will load), 409 `conflict` unless that's the restored top at that commit. 409 `nothing_set_aside` once something was committed on the change gone back to (they stay set aside for good, their branches kept), or the stack landed |
| GET | `/v1/apps/:name/git/conflicts?branch=` | `deploy`: the default branch merged into `branch` → `{branch, into, intoSha, headSha, conflicts, files}`: every file of the result; a file both sides changed is in `conflicts` and holds both versions between `<<<<<<< branch` / `=======` / `>>>>>>> into` lines. Sync it with `mergeParent: intoSha` once resolved; the deploy's merge then fast-forwards (and the commit takes the default branch's changes to what the studio doesn't hold: other folders, dotenv files; 409 `merge_dotenv_changed` if a dotenv file was edited meanwhile). 409 `merge_unresolvable` with `paths` when both sides changed something the studio can't resolve (outside the app's folder, a dotenv or binary file): merge it on GitHub |
| GET | `/v1/apps/:name/git/pulls?branch=` | `{pull: {number, url, title, draft, headSha, review: approved\|changes_requested\|pending, checks: success\|failure\|pending\|none\|unknown} \| null}`: the branch's open pull request into the default branch (for a change of a stack: its own, from submitting the stack, open or merged; none for one set aside) |
| POST | `/v1/apps/:name/git/pulls` | `deploy`: `{branch, title?, body?}` → `{pull}` (201; 200 if one was open): for a default branch that takes no direct merges (protection, reviews, checks). Opened as the user. For a change of a stack, its stack is submitted instead and its own pull request returned (201 if it was opened now, else 200), with `stackErrors` (`[{change, position, error}]`, only when there's a problem along the stack); 422 `pull_invalid` with GitHub's reason if its own couldn't be opened; 409 `set_aside` for a change set aside |
| POST | `/v1/webhooks/github` | GitHub's webhook (`push` events), signed with `CRESSLET_GITHUB_WEBHOOK_SECRET` (`X-Hub-Signature-256`; 401 otherwise, 404 when unset): a push to a linked repository's default branch is noted as the app's `repo.upstreamSha` (`GET /v1/apps/:name`), so open studios show it moved |

### Stacked changes

On a linked app, each AI builder turn that changes files is a **change**: the studio commits it with `POST /v1/apps/:name/git/stack`, which cuts a branch of its own from the commit the workspace is on and puts that one commit on it. The changes since the default branch, in order, are a **stack**; its branches are `feat/<stack>/<position>-<title>`, each one commit ahead of the one below, so the top one holds them all. A turn that changes nothing makes no branch. Hand edits made in between go into the next change (or onto the top change with `sync`). The server records each change (who made it, its title and prompt), so every browser and collaborator reads the same stacks; GitHub stays the authority for where the branches point, and reading a stack says which ones moved or are gone. Deploy merges the top change into the default branch, which lands the stack. **Submit stack** opens a pull request per change, each on the branch of the change below (the bottom one on the default branch), so each shows one request's diff; it's opened on submit, not on every turn, unless the app's `stackAutoSubmit` is on. **Fold** joins a change with the one below it. **Undo** on a change below the top adds a change on top that reverses it, keeping the later ones (conflicts, where later changes touched the same lines, are resolved first). **Land** (on a change) moves the default branch to it change by change, so each pull request shows as merged with its own turn; Deploy lands the whole stack the same way when it can (else as one merge, as before: the default branch moved, or is protected). **Going back** to a change sets the ones above it aside (their branches stay; nothing is deleted or force-pushed): the workspace loads that change's commit and the next change goes on it. Until then, **restore** puts them back; once a change is built there, they stay set aside for good. The preview database isn't versioned with changes: going back leaves its tables as they are. A change's branch **pushed to on GitHub** shows as `moved`: it can be pulled in as the top of the stack, or carried on from as a branch of its own; one deleted there shows as `gone` and leaves the rest as they are. Changes set aside are listed in Source control, deleted there, and deleted when their stack lands (with the app's delete-branch setting). A stack has at most 30 changes: past that, a turn joins the top change (`joined: true`), until the stack lands. Stacks are forgotten when the app is unlinked or linked again.

Errors: 403 `git_not_connected` (connect GitHub first), 401 `git_reauth_required` (the user revoked access or it expired: connect again; the Cresslet token itself is fine), 404 `git_not_linked`, 404 `git_unavailable` (off on this server). Deploys record what they were built from with `git: {sha, branch?, repo?}` in [POST /v1/deploys](#post-v1deploys).

<a id="pages"></a>

## Artifacts

An artifact is static HTML you share (called a page in the API: `/v1/pages`, `kind: "page"`, the `page` and `pages` keys): one file (`{"html": "…"}`, served as `index.html`) or a folder (`{"files": [{path, data, encoding}]}` with an `index.html` at the root; same size limits as deploys). No server, crons, secrets or domains: the `/v1/apps` endpoints for those answer 409 `is_page`. Each artifact gets an unguessable name (`pg-<20 hex>`), or the `name` you upload it with, and its own origin, `pg-….<domain>`, so its scripts can't read another artifact's or the studio's storage.

App or artifact? An app is software that runs: an optional server with a database, files, secrets and crons, always public, with the last 5 deploys kept for rollback. An artifact is a finished file or folder you hand to people: who can open it and how long it's kept are up to you, and it keeps only the version it serves. The CLI's `cresslet deploy` makes one or the other: a project (`cresslet.json`) or any other folder is an app; a single `.html` file, or a folder with `--artifact` (or `--visibility` / `--keep` / `--title`), is an artifact, and deploying the same file or folder again updates it (`PUT /v1/pages/:name`). `--name` picks its address.

A name you choose can be guessed: keep the generated one for a `link` artifact that only the people you send it to should open.

`visibility`:
- `private`: only its owner and [collaborators](#http-api-v1) (any role), logged in. A visitor without a session is sent to the studio (`/view/<name>?path=…`), which calls `POST /v1/pages/:name/view` and sends them back with a one-time ticket (`?cresslet_view=…`, 2 minutes). The page's host swaps it for an HttpOnly session cookie for that host only (`__Host-cresslet_page` on https, 24 h) and drops it from the URL. Each request checks that the account still has access, so removing a collaborator takes effect at once. Responses are `cache-control: private, no-store`.
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

- `app` omitted → random name. `app` unknown → created with that name, owned by the calling account (401 without one: a deploy key only deploys its own app). `app` exists → needs auth, or 409 with `"create": true` (create only).
- Create → response includes the new app's `deployKey` (store it, e.g. for CI).
- `files` = built static output. `server` = single ESM bundle (or omit for static).
- `config.crons` (optional, ≤ 5, needs `server`): cron expressions that call the server's `scheduled()` export (see app-format.md).
- `sources` (optional, same shape as `files`): the project source, stored with the deploy (not served) so another client can open it. Shares the size/file limits with `files`; if it doesn't fit, the deploy succeeds without it and the response's `deploy.warning` says so. Dropped (case-insensitive): any `.env*` name containing `local` or `cresslet`, `.envrc*`, `.dev.vars*`, top-level `dist/`, any `node_modules/`, `.git/` or `.cresslet/`. Other `.env*` files keep only their `CRESSLET_PUBLIC_*` / `VITE_*` entries, fail-closed: only single-line `NAME=value` lines (non-empty unquoted, or backslash-free `'…'`/`"…"`) are understood, comments are dropped, and the first other line ends the file. The studio sends it.
- `git` (optional): `{sha, branch?, repo?: "owner/name"}`, the commit it was built from, shown with the deploy.
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
