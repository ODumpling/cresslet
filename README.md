# Cresslet

Build and deploy small web apps. Template → code (locally, by an agent, or in the browser) → `cresslet deploy` → live on `<app>.<domain>` in under a second. Each app is siloed: own sandbox, SQLite DB, file storage, secrets, subdomain.

This repo: **platform server** (control plane + app host + studio) and app **templates**.

| Repo | What |
|---|---|
| [cresslet](https://github.com/ODumpling/cresslet) | Node server: API, workerd-sandboxed app runtime, static hosting, browser studio, templates |
| [cresslet-cli](https://github.com/ODumpling/cresslet-cli) | `cresslet` CLI: new, dev, build, deploy, logs, db, secrets |
| [cresslet-container](https://github.com/ODumpling/cresslet-container) | In-browser runtime (our WebContainer): VFS, shell, npm, dev server, previews |

## Quickstart

Requires Node ≥ 22.18 (server and CLI). The app sandbox ([workerd](https://github.com/cloudflare/workerd)) installs with `npm install`.

```sh
git clone https://github.com/ODumpling/cresslet && cd cresslet
npm install && npm run dev                   # http://localhost:8787, apps on http://<name>.localhost:8787

npx github:ODumpling/cresslet-cli new my-app
cd my-app && npm install
npm run dev                            # http://localhost:3000
npx cresslet deploy                      # → http://<name>.localhost:8787
npx cresslet logs -f
npx cresslet login && npx cresslet claim   # keep it: no expiry, outbound fetch, secrets
```

Browser: open http://localhost:8787 → pick a template → edits, `npm install`, dev server and preview all run in-browser on cresslet-container → **Deploy**.

Agents: templates ship `AGENTS.md`/`CLAUDE.md`; every CLI command takes `--json`. Raw API: [docs/api.md](docs/api.md). Server also serves `/llms.txt`.

## Docs

- [App format + server Env](docs/app-format.md)
- [HTTP API](docs/api.md)
- [Architecture, isolation, roadmap](docs/architecture.md)
- [Self-hosting](docs/self-hosting.md)

## Develop

```sh
npm run dev       # watch mode
npm test          # integration tests (spawn real sandboxes)
npm run check     # tsc
npm run vendor    # refresh studio/vendor/cresslet-container (../cresslet-container or GitHub)
# browser e2e: see tests/e2e/studio.mjs
```

MIT
