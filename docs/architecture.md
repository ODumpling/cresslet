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
/tmp/cresslet-sock/<inst>-<appId>-<n>/  per-spawn run dir (<inst>: id in data/instance, so instances sharing the dir never sweep each other's; don't point copies of one data dir at the same socket or cgroup dir), fresh each start, all the sandbox can see:
                                         config.capnp, worker.js, app.js (copy of server.js), app.json,
                                         a.sock (workerd's listener, created by the control plane), h.sock (bindings: one app per socket = identity),
                                         e.sock (egress proxy, apps with an allowlist). No secrets: fetched over HOST
```

## Isolation

- Per app: separate OS process running [workerd](https://github.com/cloudflare/workerd) (Cloudflare's open-source Workers runtime). App code sees only its bindings: no host filesystem (`node:fs` is virtual), no env, no subprocess, no native addons. V8 heap cap, request timeout → kill.
- Data access goes through the `HOST` service binding to the control plane, over a unix socket dedicated to that app. Path-traversal checks on file keys live host-side.
- Unclaimed: no outbound network. Claimed: public internet only (workerd `network = (allow = ["public"])`), so loopback/private ranges — including the control plane — are unreachable.
- Egress allowlist (optional, claimed apps): `globalOutbound` becomes an external `style = proxy` service on a per-app unix socket in the control plane (`server/egress.ts`). It forwards only to allowlisted hostnames (no IP literals), resolves them to public addresses only (checked at connect time), and refuses raw sockets (`CONNECT`). Blocked attempts are logged.
- Secrets: AES-256-GCM in `cresslet.db`, bound to (app, key). Key from `CRESSLET_SECRETS_KEY`, else generated once in `<dataDir>/secrets.key`. The sandbox fetches them over `HOST` at start; they're never written to the run dir.
- OS limits (Linux, opt-in, `server/sandbox.ts`):
  - `CRESSLET_SANDBOX_UID_BASE`: each sandbox runs as its own uid/gid (`base` + a per-app number that is never reused; control plane must be root). `dataDir` is 0700. The run dir and everything in it is root-owned and only group-readable by that app, the sockets are root:app 0660, and workerd's listening socket is created by the control plane and passed as fd 3 (`--socket-fd`), so a sandbox that escaped workerd can't read metadata, other apps' data or run dirs, or bind/swap anything the control plane connects to. Readiness is an internal probe the sandbox entry answers (not "socket accepts").
  - `CRESSLET_CGROUP_DIR`: each sandbox starts inside its own cgroup v2 child (joined before exec): `cpu.max` (`CRESSLET_APP_CPU_PERCENT`), `memory.max` (heap cap + 128 MB, no swap; OOM kill is logged), `pids.max`. Stop/exit kills the whole cgroup (`cgroup.kill`, Linux ≥ 5.14), so forked processes don't outlive it. Leftovers from a crash are swept at start.
  - Residual: an escaped uid still has the host's network (bypassing the egress allowlist; add an owner-match firewall rule if that matters), and shares world-writable `/tmp` and `/dev/shm`. Without cgroups, processes it forks aren't reaped.

## Deploy lifecycle

1. Client builds (CLI: native esbuild; studio: esbuild-wasm in cresslet-container).
2. `POST /v1/deploys` with files + server bundle → written to new immutable deploy dir.
3. Pointer swap (`apps.current_deploy_id`), sandbox stopped → next request cold-starts new code (~70 ms).
4. Last 10 deploys kept; `rollback` swaps the pointer back.

## Studio (browser)

Root host serves `studio/` with COOP/COEP. It embeds cresslet-container (our in-browser runtime: VFS, shell, npm, esbuild-wasm dev server, service-worker previews) and registers a `cresslet` command so `cresslet dev|build|deploy` work inside the browser. Server code runs in a Web Worker with the same `Env` API (sql.js DB persisted into the VFS).

Previews run on their own origin (`CRESSLET_PREVIEW_HOST`, default `preview.<domain>`), not the studio's: preview code (the user's app and its npm deps) can't read the studio's storage, where the API token lives. That host only serves the container's relay page and service worker (relay framable by the studio only); the SW forwards preview requests through the relay to the container running in the studio tab. The studio refuses to run previews without a separate preview origin, and the preview iframe is sandboxed without top-level navigation or popups (so `target=_blank` links and OAuth popups inside a preview don't open). There's no "open preview in a new tab": a top-level preview document can't be sandboxed (a same-origin wrapper can lift its own frame's sandbox), so deploy to see the app full-window.

Remaining exposure: the app's *server* code (and `node` scripts) still run in Web Workers on the studio origin. They can't read localStorage (the API token, deploy keys) but can read the studio's IndexedDB (every local project's files, including `.env.cresslet`). Moving those workers to the preview origin is a follow-up. (Chromium additionally refuses to load a studio-origin `blob:` URL inside the preview frame, which the e2e checks; Firefox and WebKit aren't verified for that, which is one more reason for the follow-up.)

## Roadmap

- Run a public hosted instance (recipe, wildcard TLS included: [self-hosting.md](self-hosting.md#production)). Named / scoped API tokens (today: one token list per account, regenerate revokes all).
- Stronger isolation: microVMs (Firecracker) or gVisor. workerd + uid + cgroups is not a hardened multi-tenant boundary (Cloudflare adds more layers in production).
- Move db/file bindings off the control-plane thread (worker thread or per-app helper) if sync SQLite becomes a bottleneck.
- Custom domains, cron/scheduled handlers, websockets.
- Source sync (git) so studio and CLI edit the same project.
- AI builder in the studio driving the same API (deferred from v1).
