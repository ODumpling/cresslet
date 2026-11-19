# Clover

Build and deploy small web apps. Template → code (locally, by an agent, or in the browser) → `clover deploy` → live on `<app>.<domain>` in under a second. Each app is siloed: own sandbox, SQLite DB, file storage, secrets, subdomain.

This repo: **platform server** (control plane + app host + studio) and app **templates**.

| Repo | What |
|---|---|
| [clover](https://github.com/ODumpling/clover) | Deno server: API, sandboxed app runtime, static hosting, browser studio, templates |
| [clover-cli](https://github.com/ODumpling/clover-cli) | `clover` CLI: new, dev, build, deploy, logs, db, secrets |
| [clover-container](https://github.com/ODumpling/clover-container) | In-browser runtime (our WebContainer): VFS, shell, npm, dev server, previews |

## Quickstart

Requires Deno ≥ 2.2 (server) and Node ≥ 22.13 (CLI).

```sh
git clone https://github.com/ODumpling/clover && cd clover
deno task dev                          # http://localhost:8787, apps on http://<name>.localhost:8787

npx github:ODumpling/clover-cli new my-app
cd my-app && npm install
npm run dev                            # http://localhost:3000
npx clover deploy                      # → http://<name>.localhost:8787
npx clover logs -f
npx clover login && npx clover claim   # keep it: no expiry, outbound fetch, secrets
```

Agents: templates ship `AGENTS.md`/`CLAUDE.md`; every CLI command takes `--json`. Raw API: [docs/api.md](docs/api.md). Server also serves `/llms.txt`.

## Docs

- [App format + server Env](docs/app-format.md)
- [HTTP API](docs/api.md)
- [Architecture, isolation, roadmap](docs/architecture.md)
- [Self-hosting](docs/self-hosting.md)

## Develop

```sh
deno task dev     # watch mode
deno task test    # integration tests (spawn real sandboxes)
deno task check
deno task vendor  # refresh studio/vendor/clover-container from GitHub
```

MIT
