# App format

A Cresslet app = static client + optional server fetch handler.

```
cresslet.json          { "name": "my-app", "routes": ["/api/*"], "crons": ["*/15 * * * *"] }
index.html           entry; local <script type="module" src> / <link rel="stylesheet"> get bundled
src/                 client code (TS/TSX/JSX/CSS/JSON/images)
public/              copied as-is to site root
server/index.ts      export default { fetch(req, env, ctx) }
.env                 CRESSLET_PUBLIC_* / VITE_* → import.meta.env (client, build time)
.env.cresslet          local dev secrets (not deployed)
.cresslet/             build output + app.json (deploy key). Gitignored.
```

## Routing

1. Path matches a `routes` pattern (default `/api/*`) and a server exists → server.
2. Static file in deploy (`/x` also tries `/x.html`, `/x/index.html`).
3. Extension-less path → `index.html` (SPA fallback).
4. `404.html` if present, else 404.

Patterns: exact (`/hook`), prefix (`/api/*` matches `/api` and `/api/...`), or `/*` (everything → server; static is then never served).

## Server Env

```ts
export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response>
}
```

WebSockets: requests with `Upgrade: websocket` on a server route reach `fetch`; answer with a `WebSocketPair` (Workers API). Open sockets keep the sandbox running; a redeploy closes them, and so does the server after 10 minutes without traffic or an hour in all by default (`CRESSLET_WS_IDLE_MS` / `CRESSLET_WS_MAX_MS`; clients should reconnect). Each app has a cap on open sockets (`CRESSLET_MAX_WEBSOCKETS_PER_APP`); past it, upgrades get 503. Works on the platform, in `cresslet dev` and in the studio preview (there, saving a server file restarts the server and closes its sockets with 1012).

```ts
if (req.headers.get("upgrade") === "websocket") {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (e) => server.send(`echo ${e.data}`));
  return new Response(null, { status: 101, webSocket: client });
}
```

Cron triggers: each `crons` entry in `cresslet.json` (standard 5-field expression incl. `MON-FRI`/`JAN` names, UTC, ≤ 5, claimed apps; one run at a time per app) calls the server's `scheduled` export; the result is logged (`cresslet logs`).

```ts
export default {
  fetch(req, env, ctx) { … },
  async scheduled(event: ScheduledEvent, env: Env, ctx) { /* event.cron, event.scheduledTime */ },
}
```

| Binding | API |
|---|---|
| `env.db` | `query(sql, ...params) → rows[]`, `first(...) → row \| null`, `run(...) → {changes, lastInsertRowid}`, `exec(sql)` — per-app SQLite (`ATTACH`/`VACUUM INTO`, temp tables, `temp_store_directory`, `fts3_tokenizer` and the size/journal pragmas are refused; plain `VACUUM` works) |
| `env.files` | `put(key, body, {contentType})`, `get(key) → Response \| null`, `delete(key)`, `list(prefix) → {key,size,contentType,updatedAt}[]` |
| `env.secrets` | `Record<string,string>`, set via `cresslet secrets set` (claimed apps) |
| `env.app` | `{ id, name, url, deployId }` |

Same API in three runtimes: platform sandbox (workerd), `cresslet dev` (Node), studio preview (browser worker, sql.js). Types: `server/cresslet.d.ts` in templates.

Runtime: Web-standard APIs (fetch, Request/Response, URL, crypto, streams, TextEncoder). npm deps are bundled by esbuild (`platform: neutral`, conditions `worker`/`browser`). No filesystem, env vars, or subprocesses. `node:` built-ins work on the platform (workerd Node compat) but not necessarily in the studio preview, so prefer Web APIs.

## Limits (defaults, configurable by operator)

| | |
|---|---|
| Deploy size | 25 MB, 2000 files |
| Server bundle | 5 MB |
| Request | 30 s (runaway handler → sandbox killed, restarted on next request) |
| Memory | 256 MB per app |
| Idle | sandbox stopped after 5 min, cold start ~70 ms |
| Unclaimed apps | expire after 72 h; no outbound network; no secrets |
| Outbound network | claimed apps: any public host, or only an allowlist (`PUT /v1/apps/:name/egress`) |
| Deploy history | last 10 (rollback) |
| Database | 512 MB per app (writes past it fail with "database or disk is full") |
| Files | 1 GB per app in all, 25 MB per file (`put` past it fails with "storage quota exceeded") |
| Apps | 50 per account |
| Deploys | 120 per app per hour (429 past it) |
