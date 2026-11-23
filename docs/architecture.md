# Architecture

```
            cresslet-cli (Node)          studio (browser, cresslet-container)          agents (curl / CLI)
                  │                                  │                                     │
                  └──────────────── POST /v1/deploys, /v1/apps/… ──────────────────────────┘
                                                     │
                       ┌─────────────────── cresslet server (Node) ───────────────────┐
                       │ main.ts   host routing: <app>.<domain> → host.ts, else /v1 │
                       │ api.ts    control plane (Hono)                              │
                       │ store.ts  metadata (SQLite, or Postgres): accounts, tokens, │
                       │           apps, deploys, secrets (db.ts, migrations.ts)     │
                       │ host.ts   static files from active deploy; routes → runtime │
                       │ runtime.ts one sandbox process per app, on demand, reaped   │
                       │ bindings.ts env.db / env.files backend (node:sqlite, disk), │
                       │           one worker thread per app (bindings-thread.ts)    │
                       └──────────────┬─────────────────────────────▲───────────────┘
                     HTTP over unix sock                 HOST binding│ (per-app unix sock)
                          ┌───────────┴─────────────────────────────┴─────────┐
                          │ workerd serve run/config.capnp (per app)           │
                          │  runtime/worker.ts wraps server.js, builds env     │
                          │  no fs, no env, no subprocess; heap cap            │
                          │  network: none (unclaimed) | public only (claimed) │
                          │  multi-tenant: under gVisor (per sandbox or whole  │
                          │  server; startup warning without)                  │
                          └────────────────────────────────────────────────────┘
```

## Data layout

```
data/cresslet.db                         metadata (unless CRESSLET_DATABASE_URL: Postgres, docs/database.md)
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
- That socket is served from a worker thread of the app's own (`serveBindings` in `server/bindings.ts`), so the app's synchronous SQLite and file index never run on the control plane's main thread: a slow query stalls only that app's bindings, not the API, the studio, or other apps. If the thread dies, its sandbox is stopped. A restarted app's next thread serves at once, but holds its file writes and deletes until the old thread has landed its accepted ones and exited. `scripts/loadtest-bindings.ts` measures control-plane latency while apps hammer their bindings (numbers in #27).
- Without an owner (anonymous apps from before they were removed, until they expire): no outbound network. Owned: public internet only (workerd `network = (allow = ["public"])`), so loopback/private ranges — including the control plane — are unreachable.
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
  - Multi-tenant instances (open signup with GitHub login) should run one of the two gVisor modes: without `CRESSLET_RUNSC` or `CRESSLET_OUTER_GVISOR`, the server warns at startup (`isolationWarnings` in `server/config.ts`), and, without `CRESSLET_RUNSC`, also warns if sandboxes share one uid. It warns rather than refuses, since `CRESSLET_OPEN_SIGNUP` defaults on for local dev.
  - Why gVisor, not Firecracker: Firecracker needs KVM (`/dev/kvm`, often missing on VPSes and in nested setups), a guest kernel and rootfs image per sandbox, and talks to the host over vsock, so the unix-socket model (`a.sock`/`h.sock`/`e.sock`) would need a vsock bridge. gVisor is two static binaries, runs without KVM (systrap platform), starts a sandbox in ~100 ms, and passes host unix sockets through, so it's a configuration of the same model rather than a new runtime.

## Deploy lifecycle

1. Client builds (CLI: native esbuild; studio: esbuild-wasm in cresslet-container).
2. `POST /v1/deploys` with files + server bundle → written to new immutable deploy dir.
3. Pointer swap (`apps.current_deploy_id`), sandbox stopped → next request cold-starts new code (~70 ms).
4. Last 5 deploys kept; `rollback` swaps the pointer back. A page (`PUT /v1/pages/:name`) keeps only the version it serves (a replaced one goes a minute later, so requests in flight finish, or sooner past 3 versions).

## Source control

An app can be linked to a GitHub repository ([api.md](api.md#source-control), [self-hosting](self-hosting.md#source-control)). [`server/git.ts`](../server/git.ts) is the only thing that talks to GitHub for it:

- **As the user.** Each account connects its own GitHub (a GitHub App's user-to-server token, refreshed before it expires under a per-account lock; or, opt-in, the login OAuth App with `repo`). Every call uses the calling account's token, so GitHub's permissions, branch protection and commit attribution are that user's; a collaborator who hasn't connected gets 403 `git_not_connected`, never the owner's access. Login keeps its minimal scopes.
- **Server-proxied.** Tokens are sealed at rest like app secrets (SecretBox, bound to the account and to which token it is) and never sent to a browser: not the studio's origin, not the preview origin. The studio and its container have no `git`; it sends the workspace's files and the server makes commits with GitHub's Git Data API (blobs, a tree on the base commit's, a commit authored as the user, then the branch moved without force, so a branch that moved meanwhile is a 409 and nothing is written).
- **The same filter as deploy source.** Files that are never source (`.env*local*`, `.dev.vars`, `.envrc`, `node_modules/`, `.git/`, …) are dropped before anything is committed, and other dotenv files keep only their public entries (`sourceFiles` in `server/deploys.ts`); repository files the studio was never sent stay as they are.
- **A change per request.** Each AI builder turn that changes files is committed as a change: a branch of its own, cut from the commit the workspace is on, so a chat's changes form a stack of branches each one commit ahead of the one below. See [stacked changes](#stacked-changes).
- **Merge, then deploy.** A connected app's Deploy commits the workspace to its branch, merges the branch into the default branch (fast-forward when it can), builds that exact commit (loading the merged files first if the default branch had commits of its own) and records `git_sha` / `git_branch` / `git_repo` on the deploy. A merge conflict or a protected branch stops before anything is deployed.
- **When the merge can't go through.** A conflict can be resolved in the workspace: the server merges the default branch into the branch file by file (both versions between conflict markers where both changed), the AI builder or the user resolves them, and the result is committed with the default branch's head as a second parent, so the deploy's merge fast-forwards. A protected default branch takes a pull request (opened as the user; its review and checks shown). A GitHub webhook (optional) marks pushes to the default branch, so open studios show it moved.

### Stacked changes

[`server/stack.ts`](../server/stack.ts) holds the stack logic; it takes the source control provider and the store, so it's tested without a network, and its routes are with the other git routes. A change is cut when the turn is committed, not before: the commit is made on the workspace's commit and the branch created pointing at it (no commit, no branch), under the next free name (`feat/<stack>/<n>-<slug>`; a name in the way, such as an older `feat/<stack>` branch, moves the stack to `<stack>-2`). An open stack's top change takes the next change; any other branch (the default one, or a branch of its own) starts a new stack, so an app can have several; a change below its stack's top takes none (another browser added one above it). One at a time per app. A deploy the AI builder starts mid-turn commits that turn as its change first; hand edits on the default branch become a change of their own when deployed. Each change is a row of `stack_changes` (stack, position, branch, the commit it holds and the one it was cut from, title, prompt, author), so a second browser or a collaborator sees the same stack. GitHub is the authority for where branches point: reading a stack checks each branch, and a branch pushed to or deleted on GitHub is shown as moved or gone. A commit Cresslet makes onto the top change from its recorded commit (a hand edit pushed, a merge resolved) moves the record with it. Deploy merges the top change into the default branch (a lower change alone is refused); that lands the stack, and its lower branches are deleted with the top one while they still point at their change. Submitting a stack opens a pull request per change as the user (`submitStack`): the bottom one into the default branch, each other into the branch below, so each shows one turn's diff, each description holding the stack's table. Pull requests open on submit, not every turn (a notification and a CI run per message otherwise), unless the app's setting submits after each change. Going back to a change marks the ones above it `set_aside` (branches kept, pull requests closed; restore reopens them): it's the top again, and the workspace loads its commit, any edits there first committed as a change (set aside with the others). The AI builder's next message says which change the workspace is on and which are set aside. Restore puts them back while the stack's top is still that change; building a new change on it moves them out of the stack for good (a set-aside change takes no commit, sync or merge). A branch pushed to from outside (its head isn't the recorded commit) is shown as such: pulling it in records that commit and drops the changes above it from the stack (they don't hold it); carrying on from it ends the stack (its changes `outside`), and the workspace commits to it as one branch. A turn on a top pushed to since is refused until one of those is done, so the push isn't left out. Set-aside branches are listed in Source control to delete, and go when their stack lands (a stack carried on from never lands: its set-aside branches are deleted by hand). A stack stops at 30 changes: later turns join the top change until it lands. Undoing a change below the top (`undoPlan`, GitHub#revert) merges the top with the change's parent, the change as the base, with the same file-by-file merge as a conflict resolution; the studio commits the result as a new change ("Undo: …"), after any conflicts are resolved. Folding a change into the one below (`fold`) rewrites no commit: the lower change leaves the stack and the upper one takes its position, base and title, its pull request pointed at the lower one's base before the lower branch is deleted. Landing up to a change (`landUpTo`, and Deploy's merge of a top when it can) moves the default branch to each change in turn, never forced, each change's pull request pointed at the default branch first: GitHub marks a pull request merged only if its base is the default branch when the default branch comes to hold it (checked against GitHub: one at a time, each merged pull request records only its own turn). Each step is recorded as it's done, so a landing that stopped half way carries on; the change above is then pointed at the default branch before any landed branch is deleted (an API delete of a base branch closes the pull requests on it). Cresslet checks the default branch's protection and rulesets itself first: GitHub lets an admin move a protected branch when protection isn't enforced for admins. On a default branch that needs pull requests, the stack lands from the bottom up through GitHub's own merge instead (`landNext`): the bottom change's pull request merged as the user, a merge commit only while its head is the change's commit, then the next pull request pointed at the default branch before the landed branch goes (`updateBottom` merges the default branch into the bottom change where it must be up to date). When the default branch moves under a stack, `restack` merges it into the bottom change and each change into the one above, recording each merge as it's made and skipping changes that hold the one below already, so a run stopped at a conflict carries on once the studio commits that change's merge (a sync below the top, allowed only with the change below's commit as `mergeParent`). Nothing is force-pushed.

## Studio (browser)

Root host serves the studio with COOP/COEP: a React app (TanStack Start in SPA mode; every studio path gets its shell) built by Vite into `studio/dist` ([docs/typescript.md](typescript.md#the-studios-build)), with the Hono `/v1` API as its only backend. It embeds cresslet-container (our in-browser runtime: VFS, shell, npm, esbuild-wasm dev server, service-worker previews) and registers a `cresslet` command so `cresslet dev|build|deploy` work inside the browser. Server code runs in a Web Worker (on the preview origin, below) with the same `Env` API (sql.js DB persisted into the VFS).

Previews run on their own origin (`CRESSLET_PREVIEW_HOST`, default `preview.<domain>`), not the studio's: preview code (the user's app and its npm deps) can't read the studio's storage, where the API token lives. That host only serves the container's relay page and service worker (relay framable by the studio only); the SW forwards preview requests through the relay to the container running in the studio tab. The studio refuses to run previews without a separate preview origin, and the preview iframe is sandboxed without top-level navigation or popups (so `target=_blank` links and OAuth popups inside a preview don't open). There's no "open preview in a new tab": a top-level preview document can't be sandboxed (a same-origin wrapper can lift its own frame's sandbox), so deploy to see the app full-window.

Project code in workers runs there too: the app's *server* code in `cresslet dev` (a container project worker, `c.projectWorker`) and `node` scripts, npm bins and the CSS worker (container `node` processes) are started by the relay frame on the preview origin, not in Web Workers on the studio origin. So they can't open the studio's IndexedDB (every local project's files, including `.env.cresslet`) or Cache Storage, and requests to the studio are cross-origin; they still get their own project's files through the container. Any `blob:` URL they mint is a preview-origin one. The e2e checks both from a `node` script and from a server route. What's left on the preview origin is one trust boundary: previews can script the relay and so reach those workers (a project's client code can do what its server code can).

### AI builder

The workspace is chat first: the **AI builder** pane (a chat with Claude that changes the open project, [`studio/builder.ts`](../studio/builder.ts)) sits beside the app's preview, **Code** swaps the preview for the files and editor, **Database** for the preview's database (its tables, and SQL run on the server worker's own sql.js connection, so the app sees the change at once and it's saved to `.cresslet/dev/db.sqlite` as the app's writes are), and **Terminal** opens a drawer with the terminal and deploy log (Deploy opens it too). The chat, the view and the drawer are remembered per browser (`cresslet.workspace` in `localStorage`). Claude's tools act on what the user can already reach from the tab: the project's files in the container, a `jsh -c` shell in the project root (stopped after 120 s), the dev server's terminal output, and `cresslet deploy`, which goes through `POST /v1/deploys` with the user's session or the project's deploy key, as the CLI would.

Claude is reached one of two ways:

- **AI credits** (when the server has `CRESSLET_ANTHROPIC_API_KEY` and the user is logged in): the browser's Anthropic SDK points at `<origin>/v1/ai` with the Cresslet token; [`server/credits.ts`](../server/credits.ts) checks the request (streamed, a listed model, client tools only), forwards it with the operator's key, streams the reply back and charges the account from the tokens in the reply's `usage` (see [AI credits](api.md#ai-credits)). The Cresslet token stays on the server.
- **Own key**: the browser calls the Anthropic API directly (`claude-opus-5-5`, streamed) with the user's own API key, kept in the studio origin's `localStorage` (`cresslet.anthropicKey`), like the Cresslet token: previews and project code run on the preview origin and can't read it. It's sent only to `api.anthropic.com`; **Forget key** removes it.

Both ways:

- Deploys need the user's yes each time: while a builder command runs (or in a process it left running, marked `CRESSLET_AI_BUILDER=1`), the in-browser `cresslet deploy` shows **Approve deploy** / **Decline** in the chat, naming the target app, before it builds, however it was started (directly, an npm script, `sh -c`, with the variable unset). Stop declines it, or aborts an upload already under way. A deploy you start in the terminal while a builder command runs asks too.
- The file tools take paths inside the project only (no absolute paths, `..` or `.git`) and refuse local secret files and directories (`.env*`, `.envrc`, `.dev.vars`), so their contents aren't sent to Anthropic by a file read. That's a guard against accidents, not a boundary: command output and the dev server's terminal (which includes what the user typed there) go to Anthropic as they are, since the model runs the user's own shell.
- A project opened from a deployed app's source keeps the builder locked (a message can be typed but not sent), like the terminal and Deploy, until **Run it**: its files (an `AGENTS.md`, say) could carry instructions for the model, and its commands would run the project's code.
- The conversation lives in the page (a reload or **New chat** starts over). The SDK bundle (`studio/vendor/anthropic.js`, from `scripts/vendor`) loads on the first message.

## Scaling out

v1 runs one server process. [`server/cluster.ts`](../server/cluster.ts) is the seam a second node would plug into; the default (`singleNode`) owns every app, so nothing changes until another implementation is passed to `createServer`.

What is node-local today:

| State | Where |
|---|---|
| Metadata (accounts, tokens, apps, deploys, secrets, domains) | `data/cresslet.db`, or Postgres with `CRESSLET_DATABASE_URL` ([database.md](database.md)); `Store` (async; all its SQL is in `server/store.ts`) |
| App files: deploys, `db.sqlite`, `files/` | `data/apps/<appId>/` |
| Sandboxes | `Runtime`: one process per app on this host |
| Logs | `Logs`: in-memory ring buffer per app |
| Crons, reaping (expired and long-deleted apps) | timers in this process |
| Hourly abuse limits (new apps and pages, deploys) | `rate_hits` in the metadata database |
| CLI login limits, GitHub OAuth state and exchange codes | in memory |

Design: app affinity. Each app has one owner node. The owner holds `data/apps/<appId>/`, runs the sandbox, keeps the app's logs, fires its crons and reaps it. Any node takes any request; one for an app it doesn't own goes to the owner unchanged, and the owner answers it with today's code. `Runtime`, `Logs`, `Scheduler` and `host.ts` stay node-local. Forwarding whole requests, rather than sandbox calls, keeps static files, logging and the per-app deploy limit on the owner, and avoids sending `AppSpec` (it carries closures over the store).

`Cluster` has three methods: `local(appId)` says whether this node owns the app, `forward(appId, req)` sends an HTTP request to the owner, and `forwardUpgrade(appId, …)` does the same for a WebSocket upgrade. The server calls them in these places:

- App hosts (subdomain or verified custom domain), HTTP and WebSocket upgrades: `main.ts`, after the host name resolves to an app.
- App-scoped API calls: `/v1/apps/:name[/…]` and `/v1/admin/sites/:name[/…]` (soft-deleted sites included, so restore and purge run where the files are). The API forwards them before auth, and the owner authorizes against the shared metadata. `POST /v1/deploys` names its app in the body, so with more than one node the API reads the body first, then forwards the request byte for byte, also before auth (or right after it, if the app appeared on another node during the token check). A single node skips that step. Deploys, rollbacks, secret and egress changes, logs (including `?follow=1`), source, the data browser, usage and purge therefore all run on the owner.
- Crons: the scheduler only queues apps this node owns, and checks again at dispatch, since a queued run can outlive a move.
- Reaping: only apps this node owns.

Left before a second node works:

- Shared metadata: done. With `CRESSLET_DATABASE_URL` every node can use one Postgres database ([database.md](database.md)); `Store` is async, and its check-then-write paths (quota checks inside `createApp`, rate limits, AI wallets, uid numbers) run in transactions under advisory locks, so they hold across nodes.
- Secrets key: every node needs the same `CRESSLET_SECRETS_KEY`, or a shared `secrets.key`. `data/instance` stays per node.
- A real `Cluster`, with these pieces:
  - a node registry and health checks
  - placement (an owner per app, and an owner chosen when an app is created; new apps are created on the node that took the deploy)
  - forwarding over HTTP that keeps the client IP for app hosts, drops hop-by-hop headers, and streams in both directions, so `logs?follow=1` and cancellation work end to end
  - a hop guard, so two nodes that disagree about an owner don't forward to each other forever
  - an answer when the owner is unreachable (a 502, not the generic 500 a rejected `forward` gives today)
  - moving an app, and failover
- Node-wide state that has to be shared or made sticky: GitHub OAuth state and exchange codes, and `/v1/admin/sites` usage (it reads local disk for every site).

## Roadmap

- Stronger isolation: the public instance runs the whole server under gVisor, and any other multi-tenant instance without a gVisor mode gets a startup warning (see [Isolation](#isolation)). Next, where KVM is available: Firecracker microVMs, a guest kernel per app (needs a vsock bridge for the unix sockets, and a kernel and rootfs per sandbox).
