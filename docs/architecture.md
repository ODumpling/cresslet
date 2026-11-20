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
                       │ bindings.ts env.db / env.files backend (node:sqlite, disk), │
                       │           one worker thread per app (bindings-thread.ts)    │
                       └──────────────┬─────────────────────────────▲───────────────┘
                     HTTP over unix sock                 HOST binding│ (per-app unix sock)
                          ┌───────────┴─────────────────────────────┴─────────┐
                          │ workerd serve run/config.capnp (per app)           │
                          │  runtime/worker.js wraps server.js, builds env     │
                          │  no fs, no env, no subprocess; heap cap            │
                          │  network: none (unclaimed) | public only (claimed) │
                          │  multi-tenant: under gVisor (per sandbox or whole  │
                          │  server; startup warning without)                  │
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
                                         gVisor mode: l/ (the one dir the sandbox can write: workerd binds l/a.sock, adopted as a.sock)
/tmp/cresslet-sock/<run dir>.gv/        gVisor mode: runsc state + OCI bundle (never visible inside the sandbox)
```

## Isolation

- Per app: separate OS process running [workerd](https://github.com/cloudflare/workerd) (Cloudflare's open-source Workers runtime). App code sees only its bindings: no host filesystem (`node:fs` is virtual), no env, no subprocess, no native addons. V8 heap cap, request timeout → kill.
- Data access goes through the `HOST` service binding to the control plane, over a unix socket dedicated to that app. Path-traversal checks on file keys live host-side.
- That socket is served from a worker thread of the app's own (`serveBindings` in `server/bindings.ts`), so the app's synchronous SQLite and file index never run on the control plane's main thread: a slow query stalls only that app's bindings, not the API, the studio, or other apps. If the thread dies, its sandbox is stopped; a restarted app's next thread starts only after the old one's accepted file writes have landed. `scripts/loadtest-bindings.ts` measures control-plane latency while apps hammer their bindings (numbers in #27).
- Unclaimed: no outbound network. Claimed: public internet only (workerd `network = (allow = ["public"])`), so loopback/private ranges — including the control plane — are unreachable.
- Egress allowlist (optional, claimed apps): `globalOutbound` becomes an external `style = proxy` service on a per-app unix socket in the control plane (`server/egress.ts`). It forwards only to allowlisted hostnames (no IP literals), resolves them to public addresses only (checked at connect time), and refuses raw sockets (`CONNECT`). Blocked attempts are logged.
- Secrets: AES-256-GCM in `cresslet.db`, bound to (app, key). Key from `CRESSLET_SECRETS_KEY`, else generated once in `<dataDir>/secrets.key`. The sandbox fetches them over `HOST` at start; they're never written to the run dir.
- OS limits (Linux, opt-in, `server/sandbox.ts`):
  - `CRESSLET_SANDBOX_UID_BASE`: each sandbox runs as its own uid/gid (`base` + a per-app number that is never reused; control plane must be root). `dataDir` is 0700. The run dir and everything in it is root-owned and only group-readable by that app, the sockets are root:app 0660, and workerd's listening socket is created by the control plane and passed as fd 3 (`--socket-fd`), so a sandbox that escaped workerd can't read metadata, other apps' data or run dirs, or bind/swap anything the control plane connects to. Readiness is an internal probe the sandbox entry answers (not "socket accepts").
  - `CRESSLET_CGROUP_DIR`: each sandbox starts inside its own cgroup v2 child (joined before exec): `cpu.max` (`CRESSLET_APP_CPU_PERCENT`), `memory.max` (heap cap + 128 MB, no swap; OOM kill is logged), `pids.max`. Stop/exit kills the whole cgroup (`cgroup.kill`, Linux ≥ 5.14), so forked processes don't outlive it. Leftovers from a crash are swept at start.
  - Residual: an escaped uid still has the host's network (bypassing the egress allowlist; add an owner-match firewall rule if that matters), and shares world-writable `/tmp` and `/dev/shm`. Without cgroups, processes it forks aren't reaped. gVisor mode closes these.
  - `CRESSLET_RUNSC` (gVisor mode): each sandbox is `runsc run` of a generated OCI bundle, so workerd's syscalls go to gVisor's user-space kernel (the Sentry), not the host's. Code that escapes workerd lands in the Sentry and sees:
    - Filesystem: a read-only root of only mount points: its run dir (read-only, except `l/`), the workerd binary, system library dirs and CA certificates. No `/etc`, no data dir, no other run dirs. `/tmp` and `/dev/shm` are the Sentry's own tmpfs (private, charged to its memory).
    - Network: `--network=none`, so loopback only, in a fresh network namespace; the host's interfaces (and the control plane's ports) are unreachable. The only way out is its unix sockets (`--host-uds`): `h.sock`, and `e.sock` for outbound. Claimed apps' outbound therefore always goes through the egress proxy; without an allowlist the proxy allows any public host (IP literals and DNS answers checked like the allowlist path, raw sockets tunnelled via `CONNECT` to public addresses only). Unclaimed apps still have no outbound at all (not even DNS). Through the proxy, outbound WebSockets and TLS raw sockets (`secureTransport: "on"` / `"starttls"`) aren't available, as with an allowlist today; plain HTTP(S) and plain TCP are.
    - Processes: its own pid namespace; no capabilities, `no_new_privs`. With `CRESSLET_SANDBOX_UID_BASE` the process inside runs as the app's uid (the host processes are runsc's, as root); with `CRESSLET_CGROUP_DIR` runsc, the Sentry and the gofer all start in the app's cgroup (`memory.max` gets +64 MB for them; an idle sandbox uses ~40 MB in all).
    - Listener: the Sentry can't accept on a host listening socket passed in as an fd, so in this mode workerd binds `l/a.sock` itself. Once it exists the control plane hard-links it into the root-owned run dir as `a.sock` (`link()` doesn't follow symlinks) and keeps it only if it's a socket, so what it connects to can't be swapped later.
    - Teardown: the run dir (with `l/`) is removed only after `runsc delete` and `runsc list` confirm the sandbox is gone, off the event loop; the startup sweep reaps leftover sandboxes before it removes their run dirs, and leaves both in place (logged) if it can't confirm.
    - Residual: `l/` is a host directory the sandbox can write to (it could fill the disk under `CRESSLET_SOCK_DIR`; put that on a size-limited tmpfs such as `/run` to bound it). runsc itself and its gofer run as root on the host (gVisor's own seccomp/namespace confinement applies). A crashed control plane leaves runsc running when there are no cgroups; the next start `runsc delete`s it (with `CRESSLET_RUNSC` still set).
  - gVisor around the whole server (Docker `runtime: runsc`, as `deploy/coolify` and the public instance run): code that escapes workerd, and the control plane itself, land in the Sentry, not the host kernel. (On Coolify, `deploy/coolify/firewall.sh`, installed separately, keeps the container's network off the host and private ranges; traffic between it and other containers on the same bridge, such as Coolify's Traefik, stays allowed both ways.) Apps share that one Sentry with each other and the control plane, so per-app uids (`CRESSLET_SANDBOX_UID_BASE`) are what keep them out of each other's files; the residuals of the uid mode above apply inside the container. `CRESSLET_OUTER_GVISOR=true` tells the server it runs this way (it can't check).
  - Multi-tenant instances (anonymous deploys, or open signup with GitHub login) should run one of the two gVisor modes: without `CRESSLET_RUNSC` or `CRESSLET_OUTER_GVISOR`, the server warns at startup (`isolationWarnings` in `server/config.ts`), and, without `CRESSLET_RUNSC`, also warns if sandboxes share one uid. It warns rather than refuses, since `CRESSLET_ANON_DEPLOYS` and `CRESSLET_OPEN_SIGNUP` default on for local dev.
  - Why gVisor, not Firecracker: Firecracker needs KVM (`/dev/kvm`, often missing on VPSes and in nested setups), a guest kernel and rootfs image per sandbox, and talks to the host over vsock, so the unix-socket model (`a.sock`/`h.sock`/`e.sock`) would need a vsock bridge. gVisor is two static binaries, runs without KVM (systrap platform), starts a sandbox in ~100 ms, and passes host unix sockets through, so it's a configuration of the same model rather than a new runtime.

## Deploy lifecycle

1. Client builds (CLI: native esbuild; studio: esbuild-wasm in cresslet-container).
2. `POST /v1/deploys` with files + server bundle → written to new immutable deploy dir.
3. Pointer swap (`apps.current_deploy_id`), sandbox stopped → next request cold-starts new code (~70 ms).
4. Last 10 deploys kept; `rollback` swaps the pointer back.

## Studio (browser)

Root host serves `studio/` with COOP/COEP. It embeds cresslet-container (our in-browser runtime: VFS, shell, npm, esbuild-wasm dev server, service-worker previews) and registers a `cresslet` command so `cresslet dev|build|deploy` work inside the browser. Server code runs in a Web Worker (on the preview origin, below) with the same `Env` API (sql.js DB persisted into the VFS).

Previews run on their own origin (`CRESSLET_PREVIEW_HOST`, default `preview.<domain>`), not the studio's: preview code (the user's app and its npm deps) can't read the studio's storage, where the API token lives. That host only serves the container's relay page and service worker (relay framable by the studio only); the SW forwards preview requests through the relay to the container running in the studio tab. The studio refuses to run previews without a separate preview origin, and the preview iframe is sandboxed without top-level navigation or popups (so `target=_blank` links and OAuth popups inside a preview don't open). There's no "open preview in a new tab": a top-level preview document can't be sandboxed (a same-origin wrapper can lift its own frame's sandbox), so deploy to see the app full-window.

Project code in workers runs there too: the app's *server* code in `cresslet dev` (a container project worker, `c.projectWorker`) and `node` scripts, npm bins and the CSS worker (container `node` processes) are started by the relay frame on the preview origin, not in Web Workers on the studio origin. So they can't open the studio's IndexedDB (every local project's files, including `.env.cresslet`) or Cache Storage, and requests to the studio are cross-origin; they still get their own project's files through the container. Any `blob:` URL they mint is a preview-origin one. The e2e checks both from a `node` script and from a server route. What's left on the preview origin is one trust boundary: previews can script the relay and so reach those workers (a project's client code can do what its server code can).

## Roadmap

- Stronger isolation: the public instance runs the whole server under gVisor, and any other multi-tenant instance without a gVisor mode gets a startup warning (see [Isolation](#isolation)). Next, where KVM is available: Firecracker microVMs, a guest kernel per app (needs a vsock bridge for the unix sockets, and a kernel and rootfs per sandbox).
- AI builder in the studio driving the same API (deferred from v1).
