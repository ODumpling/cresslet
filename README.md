# Cresslet

Build and deploy small web apps. Template → code (locally, by an agent, or in the browser) → `cresslet deploy` → live on `<app>.<domain>` in under a second. Each app is siloed: own sandbox, SQLite DB, file storage, secrets, subdomain.

This repo: **platform server** (control plane + app host + studio) and app **templates**.

| Repo | What |
|---|---|
| [cresslet](https://github.com/ODumpling/cresslet) | Node server: API, workerd-sandboxed app runtime, static hosting, browser studio, templates |
| [cresslet-cli](https://github.com/ODumpling/cresslet-cli) | `cresslet` CLI ([npm](https://www.npmjs.com/package/cresslet)): new, dev, build, deploy, logs, db, secrets |
| [cresslet-container](https://github.com/ODumpling/cresslet-container) | In-browser runtime (our WebContainer): VFS, shell, npm, dev server, previews |

## Quickstart

Requires Node ≥ 24.12 for the server (≥ 22.18 for the CLI). The app sandbox ([workerd](https://github.com/cloudflare/workerd)) installs with `npm install`.

```sh
git clone https://github.com/ODumpling/cresslet && cd cresslet
npm install && npm run dev                   # http://localhost:8787, apps on http://<name>.localhost:8787

npm i -g cresslet                            # or use npx cresslet …
cresslet config set api http://localhost:8787   # the CLI talks to https://cresslet.dev by default
cresslet new my-app
cd my-app && npm install
npm run dev                            # http://localhost:3000
npx cresslet auth login                  # browser login (if GitHub or password login is configured); every app belongs to an account
npx cresslet deploy                      # → http://<name>.localhost:8787
npx cresslet logs -f
```

Browser: open http://localhost:8787 → pick a template → the **AI builder** chat opens beside the live preview: ask Claude for a change, or switch to **Code** to edit it yourself (**Database**: the preview's tables, and SQL on them). `npm install`, the dev server and the preview all run in-browser on cresslet-container → **Deploy**. Claude runs on the account's AI credits when the server has an Anthropic key (`CRESSLET_ANTHROPIC_API_KEY`, metered per token: [docs/api.md#ai-credits](docs/api.md#ai-credits)), or on your own Anthropic API key, called straight from the browser ([docs/architecture.md#ai-builder](docs/architecture.md#ai-builder)).

Apps: each deployed app gets a dashboard in the studio: metrics, logs, rollback (last 5 deploys), database explorer, secrets, crons, domains and egress. Apps belong to an account; organizations share apps between members.

Source control (optional, [docs/architecture.md#source-control](docs/architecture.md#source-control)): link an app to a GitHub repo and the server commits, branches and merges as the signed-in user. Each AI builder request becomes its own change (a branch one commit ahead of the one below), so a chat builds a **stack**: submit it as a chain of pull requests, go back, undo or fold a change, restack when `main` moves, land it (through PRs on a protected branch). **Open in studio** on a linked app starts on its default branch, running. **Deploy** merges into the default branch, deploys that commit and tags it with the next version (`v1`, `v2`…). Nothing is force-pushed.

Artifacts: deploy a static HTML file or folder (studio **Artifacts**, or `cresslet deploy report.html`; a folder with `--artifact`) and share it: private (you and people you invite), anyone with the link, or public; kept 30 days unless you or your account defaults say otherwise. Deploy it again to update the same URL; `--name` picks the address ([docs/api.md#artifacts](docs/api.md#artifacts)).

Templates: `react`, `vanilla`, and `tanstack-start` (TanStack Start SSR + server functions, email/password auth with `db` + `kv` sessions; CLI only: `cresslet new my-app --template tanstack-start`).

Agents: templates ship `AGENTS.md`/`CLAUDE.md`; every CLI command takes `--json`. Raw API: [docs/api.md](docs/api.md). Server also serves `/llms.txt`.

## Docs

- [App format + server Env](docs/app-format.md)
- [HTTP API](docs/api.md)
- [Architecture, isolation, roadmap](docs/architecture.md)
- [Self-hosting](docs/self-hosting.md) (GitHub login, source control, env vars)
- [Metadata database: SQLite or Postgres, migrations](docs/database.md)
- [TypeScript: how the code runs, tsconfigs, rules](docs/typescript.md)

## Develop

```sh
npm run dev       # watch mode; the studio through Vite (hot reload)
npm run build     # the studio's production build (studio/dist), which npm start serves
npm test          # integration tests (spawn real sandboxes)
npm run check     # tsc (every project) + the route tree + the TypeScript-only check
npm run vendor    # refresh studio/vendor/cresslet-container (../cresslet-container or GitHub)
# browser e2e: see tests/e2e/studio.ts
```

Everything is TypeScript. The server runs from its `.ts` files with no build step; the studio (React on TanStack Start)
is built by Vite: [docs/typescript.md](docs/typescript.md).

MIT
