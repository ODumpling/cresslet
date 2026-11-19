# App format

A Cresslet app = static client + optional server fetch handler.

```
cresslet.json          { "name": "my-app", "routes": ["/api/*"] }
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

| Binding | API |
|---|---|
| `env.db` | `query(sql, ...params) → rows[]`, `first(...) → row \| null`, `run(...) → {changes, lastInsertRowid}`, `exec(sql)` — per-app SQLite |
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
| Deploy history | last 10 (rollback) |
