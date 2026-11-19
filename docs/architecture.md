# Architecture

```
            clover-cli (Node)          studio (browser, clover-container)          agents (curl / CLI)
                  │                                  │                                     │
                  └──────────────── POST /v1/deploys, /v1/apps/… ──────────────────────────┘
                                                     │
                       ┌─────────────────── clover server (Deno) ───────────────────┐
                       │ main.ts   host routing: <app>.<domain> → host.ts, else /v1 │
                       │ api.ts    control plane (Hono)                              │
                       │ store.ts  metadata SQLite: accounts, tokens, apps, deploys, │
                       │           secrets                                           │
                       │ host.ts   static files from active deploy; routes → runtime │
                       │ runtime.ts one sandbox process per app, on demand, reaped   │
                       └────────────────────────────┬───────────────────────────────┘
                                                    │ HTTP over unix socket
                          ┌─────────────────────────┴─────────────────────────┐
                          │ deno run runtime/runner.ts (per app)               │
                          │  --allow-read=<app dir>  --allow-write=<app data>  │
                          │  --allow-net=unix:<sock> (unclaimed) | all (claimed)│
                          │  --no-remote --no-npm, clearEnv, heap cap          │
                          │  env.db (node:sqlite) env.files env.secrets        │
                          └────────────────────────────────────────────────────┘
```

## Data layout

```
data/clover.db                         metadata
data/apps/<appId>/deploys/<depId>/     immutable: public/, server.js, deploy.json
data/apps/<appId>/data/db.sqlite       app database (survives deploys)
data/apps/<appId>/data/files/          app file storage
data/apps/<appId>/run/config.json      sandbox config (0600)
/tmp/clover-sock/<appId>.sock          sandbox socket
```

## Isolation

- Per app: separate OS process, Deno permission sandbox (fs scoped to its own dir, writes only to its data dir, no env, no subprocess, no FFI, no remote imports), V8 heap cap, request timeout → kill.
- Unclaimed: no outbound network (only its own socket). Claimed: outbound network.
- Not yet: CPU quotas (cgroups), per-app UID, egress allowlists. See roadmap.

## Deploy lifecycle

1. Client builds (CLI: native esbuild; studio: esbuild-wasm in clover-container).
2. `POST /v1/deploys` with files + server bundle → written to new immutable deploy dir.
3. Pointer swap (`apps.current_deploy_id`), sandbox stopped → next request cold-starts new code (~70 ms).
4. Last 10 deploys kept; `rollback` swaps the pointer back.

## Studio (browser)

Root host serves `studio/` with COOP/COEP. It embeds clover-container (our in-browser runtime: VFS, shell, npm, esbuild-wasm dev server, service-worker previews) and registers a `clover` command so `clover dev|build|deploy` work inside the browser. Server code runs in a Web Worker with the same `Env` API (sql.js DB persisted into the VFS).

## Roadmap

- Hosted instance + wildcard TLS; GitHub OAuth / email-verified login.
- Stronger isolation: per-app UID + cgroups, or move sandboxes to workerd / Firecracker.
- Secrets encrypted at rest; egress allowlist for claimed apps.
- Custom domains, cron/scheduled handlers, websockets.
- Source sync (git) so studio and CLI edit the same project.
- AI builder in the studio driving the same API (deferred from v1).
- Separate preview origin for studio (preview code is currently same-origin with the studio).
