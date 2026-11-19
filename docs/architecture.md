# Architecture

```
            cresslet-cli (Node)          studio (browser, cresslet-container)          agents (curl / CLI)
                  │                                  │                                     │
                  └──────────────── POST /v1/deploys, /v1/apps/… ──────────────────────────┘
                                                     │
                       ┌─────────────────── cresslet server (Node) ───────────────────┐
                       │ main.ts   host routing: <app>.<domain> → host.ts, else /v1 │
                       │ api.ts    control plane (Hono)                              │
                       │ store.ts  metadata SQLite: accounts, tokens, apps, deploys, │
                       │           secrets                                           │
                       │ host.ts   static files from active deploy; routes → runtime │
                       │ runtime.ts one sandbox process per app, on demand, reaped   │
                       │ bindings.ts env.db / env.files backend (node:sqlite, disk)  │
                       └──────────────┬─────────────────────────────▲───────────────┘
                     HTTP over unix sock                 HOST binding│ (per-app unix sock)
                          ┌───────────┴─────────────────────────────┴─────────┐
                          │ workerd serve run/config.capnp (per app)           │
                          │  runtime/worker.js wraps server.js, builds env     │
                          │  no fs, no env, no subprocess; heap cap            │
                          │  network: none (unclaimed) | public only (claimed) │
                          └────────────────────────────────────────────────────┘
```

## Data layout

```
data/cresslet.db                         metadata
data/apps/<appId>/deploys/<depId>/     immutable: public/, server.js, deploy.json
data/apps/<appId>/data/db.sqlite       app database (survives deploys)
data/apps/<appId>/data/files/          app file storage
data/apps/<appId>/run/                 generated workerd config, worker.js, secrets.json (0600)
/tmp/cresslet-sock/<appId>-<n>.sock      sandbox socket (fresh per spawn)
/tmp/cresslet-sock/<appId>-<n>.host.sock bindings socket (one app per socket = identity)
```

## Isolation

- Per app: separate OS process running [workerd](https://github.com/cloudflare/workerd) (Cloudflare's open-source Workers runtime). App code sees only its bindings: no host filesystem (`node:fs` is virtual), no env, no subprocess, no native addons. V8 heap cap, request timeout → kill.
- Data access goes through the `HOST` service binding to the control plane, over a unix socket dedicated to that app. Path-traversal checks on file keys live host-side.
- Unclaimed: no outbound network. Claimed: public internet only (workerd `network = (allow = ["public"])`), so loopback/private ranges — including the control plane — are unreachable.
- Not yet: CPU quotas (cgroups), per-app UID, egress allowlists. See roadmap.

## Deploy lifecycle

1. Client builds (CLI: native esbuild; studio: esbuild-wasm in cresslet-container).
2. `POST /v1/deploys` with files + server bundle → written to new immutable deploy dir.
3. Pointer swap (`apps.current_deploy_id`), sandbox stopped → next request cold-starts new code (~70 ms).
4. Last 10 deploys kept; `rollback` swaps the pointer back.

## Studio (browser)

Root host serves `studio/` with COOP/COEP. It embeds cresslet-container (our in-browser runtime: VFS, shell, npm, esbuild-wasm dev server, service-worker previews) and registers a `cresslet` command so `cresslet dev|build|deploy` work inside the browser. Server code runs in a Web Worker with the same `Env` API (sql.js DB persisted into the VFS).

## Roadmap

- Hosted instance + wildcard TLS. Named / scoped API tokens (today: one token list per account, regenerate revokes all).
- Stronger isolation: per-app UID + cgroups, or Firecracker. workerd alone is not a hardened multi-tenant boundary (Cloudflare adds more layers in production).
- Move db/file bindings off the control-plane thread (worker thread or per-app helper) if sync SQLite becomes a bottleneck.
- Secrets encrypted at rest; egress allowlist for claimed apps.
- Custom domains, cron/scheduled handlers, websockets.
- Source sync (git) so studio and CLI edit the same project.
- AI builder in the studio driving the same API (deferred from v1).
- Separate preview origin for studio (preview code is currently same-origin with the studio).
