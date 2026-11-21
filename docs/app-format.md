# App format

A Cresslet app = static client + optional server fetch handler.

```
cresslet.json          { "name": "my-app", "routes": ["/api/*"], "crons": ["*/15 * * * *"] }
index.html           entry; local <script type="module" src> / <link rel="stylesheet"> get bundled
src/                 client code (TS/TSX/JSX/CSS/JSON/images)
public/              copied as-is to site root
server/index.ts      export default { fetch(req, env, ctx) }; bindings: import { db, files, secrets, app } from "cresslet"
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
import { db, secrets, type Env, type ExecutionContext } from "cresslet"; // the cresslet npm package (SDK + CLI), bundled into server.js

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const id = Number(new URL(req.url).searchParams.get("id"));
    const todo = await db.first(db.sql`SELECT * FROM todos WHERE id = ${id}`);
    const res = await fetch("https://api.stripe.com/v1/balance", {
      headers: { authorization: `Bearer ${secrets.get("STRIPE_KEY")}` }, // server-side only
    });
    return Response.json({ todo, stripeOk: res.ok });
  },
};
```

The bindings come from the `cresslet` package's imports, or from the `env` argument (the same bindings; `env` keeps working
for apps deployed before the SDK). Types (`Env`, `ScheduledEvent`, `WebSocketPair`, …) ship in the package: a project
made before 0.2.0 deletes its `server/cresslet.d.ts` when it starts importing from `"cresslet"` (its globals would be
declared twice). `lastInsertRowid` is SQLite's; `INSERT … RETURNING id` works on any provider. Awaiting a ``db.sql`…` ``
runs it, so return one from an `async` function only to run it.

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
| `db` | ``sql`…${v}` `` → a statement whose values are parameters (a nested `db.sql` is spliced in); `query(q)` → rows (or `await q`), `first(q)` → row \| null, `run(q)` → `{changes, lastInsertRowid}`; each also takes `(sql, ...params)` with `?`. `exec(sql)` (DDL, no params). `batch([q, "sql", {sql, params}, …])` → `{rows, changes, lastInsertRowid}[]`: one transaction (a savepoint), all or none, with no other statement in between; transaction control (`BEGIN`, `COMMIT`, `SAVEPOINT`, …) isn't allowed in it. Inside a transaction the app opened with `exec("BEGIN")`, a batch is part of it, and SQLite's `OR ROLLBACK` conflict clause rolls back that whole transaction. Per-app SQLite, SQLite SQL (`ATTACH`/`VACUUM INTO`, temp tables, `temp_store_directory`, `fts3_tokenizer` and the size/journal pragmas are refused; plain `VACUUM` works) |
| `files` | `put(key, body, {contentType})`, `get(key) → Response \| null`, `delete(key)`, `list(prefix) → {key,size,contentType,updatedAt}[]` |
| `secrets` | `get(name)` (throws, naming it, if unset), `optional(name) → string \| undefined`, record access (`secrets.NAME`, `Object.keys(secrets)`). Set via `cresslet secrets set` (claimed apps); `.env.cresslet` locally |
| `app` | `{ id, name, url, deployId }` |

`env` has the same `db` (minus `sql`; `query/first/run/exec` take SQL strings, `batch` takes `{sql, params}[]`), `files`,
`secrets` (a plain record) and `app`.

Same API in three runtimes: platform sandbox (workerd), `cresslet dev` (Node), studio preview (browser worker, sql.js).
The studio preview runs SQLite as sql.js, which binds integers beyond 32 bits as REAL (exact up to 2^53: stored as
INTEGER in an `INTEGER` column, but integer division and `typeof()` on the parameter itself differ) and refuses
bigints past ±2^53; the platform and `cresslet dev` bind 64-bit integers. Studio builds resolve `"cresslet"` to the SDK the studio ships (`studio/vendor/cresslet-sdk.js`), not the project's
`node_modules/cresslet`.

Bindings exist once a handler runs: in the sandbox they load on the first request or cron run. Using the SDK at module
top level throws a `CressletError` that says so.

### SDK runtime contract

Each runtime publishes the env on `globalThis[Symbol.for("cresslet.runtime")]` as
`{ contract, runtime, paramStyle, env }` (`env` null while the app's module evaluates): `runtime/cresslet-runtime.js` in
the sandbox, `cresslet dev`, `studio/server-worker.js`. The SDK is bundled into the app while the platform is updated
on its own, so `contract` is versioned: it grows by one with each addition the SDK relies on, and nothing a contract had
is removed. The SDK knows which contract each feature needs and throws a `CressletError` naming what to update when a
runtime is older (or publishes nothing: a platform, studio or `cresslet dev` from before the SDK). `paramStyle` (`?`
here) is how `db.sql` writes placeholders, so a provider with `$1`-style parameters can sit behind the same `db.sql`.

| Contract | Adds | cresslet (SDK) |
|---|---|---|
| 1 | env published for the SDK, `env.db.batch` (host `POST /db/batch {statements}`), `paramStyle` | 0.2.0 |

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
