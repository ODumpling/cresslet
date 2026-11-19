# HTTP API (v1)

Base: `http://localhost:8787` (self-hosted default). JSON in/out. CORS `*`.

Auth (either):
- `Authorization: Bearer clv_acct_…` — account token (`POST /v1/accounts`).
- `X-Clover-Deploy-Key: clv_app_…` (or `Authorization: Bearer clv_app_…`) — per-app key, returned once on app creation.

Errors: `{ "error": "<code>", "message": "…" }` with 4xx/5xx.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1` | server info, limits, app URL template |
| POST | `/v1/accounts` | `{email}` → `{account, token}`. v1: no verification (operator can disable: `CLOVER_OPEN_SIGNUP=false`) |
| GET | `/v1/me` | account |
| GET | `/v1/templates` | `{templates: [{name, description}]}` |
| GET | `/v1/templates/:name` | `{files: [{path, data, encoding: utf8\|base64}]}` |
| POST | `/v1/deploys` | see below |
| GET | `/v1/apps` | account's apps |
| GET | `/v1/apps/:name` | app, last 10 deploys, runtime status, secret names |
| DELETE | `/v1/apps/:name` | delete app + data |
| POST | `/v1/apps/:name/claim` | account auth + `{deployKey}` → no expiry, net + secrets |
| POST | `/v1/apps/:name/rollback` | `{deployId?}` (default: previous) |
| GET | `/v1/apps/:name/logs?n=200&follow=1` | NDJSON `{t, kind: stdout\|stderr\|system\|request, msg}`; `follow` streams |
| GET | `/v1/apps/:name/secrets` | `{keys}` (values are write-only) |
| PUT | `/v1/apps/:name/secrets` | `{KEY: "value" \| null}` merge; claimed apps only |
| DELETE | `/v1/apps/:name/secrets/:key` | |
| GET | `/v1/apps/:name/db?limit=100` | tables → `{schema, count, rows}` |
| POST | `/v1/apps/:name/db/query` | `{sql, params?}` read-only → `{rows}` |

## POST /v1/deploys

```json
{
  "app": "my-app",
  "files": [{ "path": "index.html", "data": "<h1>hi</h1>", "encoding": "utf8" },
            { "path": "assets/logo.png", "data": "iVBOR…", "encoding": "base64" }],
  "server": "export default { fetch(req, env) { … } }",
  "config": { "routes": ["/api/*"] },
  "source": "cli"
}
```

- `app` omitted → random name. `app` unknown → created with that name. `app` exists → needs auth.
- Anonymous create → app expires (`expiresAt`), response includes `deployKey` (store it).
- Logged-in create → claimed immediately.
- `files` = built static output. `server` = single ESM bundle (or omit for static).
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
