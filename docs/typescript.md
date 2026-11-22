# TypeScript

The code in this repo is TypeScript, type-checked strictly. The server, runtime, scripts and tests have no build step:
they run from the `.ts` sources, with types removed by Node's built-in type stripping where it runs, and by the server
where it doesn't. The studio is the one part with a build: Vite bundles it (`npm run build`, or Vite itself under
`npm run dev`).

## How each part runs

| Code | Runs in | How it gets JavaScript |
| --- | --- | --- |
| `server/`, `scripts/*.ts`, `tests/*_test.ts`, `tests/e2e/*.ts` | Node 24 | Node's type stripping (`node server/main.ts`) |
| `studio/src/` (the React app) and the modules it imports (`studio/*.ts`) | the browser (the page) | bundled by Vite ([`studio/vite.config.ts`](../studio/vite.config.ts)) into `studio/dist/client`: a prerendered shell (`_shell.html`) and content-hashed assets under `/assets/` |
| `studio/server-worker.ts`, `studio/start-service.ts` | a preview worker; a container `node` process | types stripped at build time and served as they are at a stable URL (`/server-worker.js`, `/start-service.js`); likewise `vendor/cresslet-sdk.js` and cresslet-container's dist (`/vendor/cresslet-container/…`, whose workers resolve beside it) |
| `runtime/*.ts` | workerd (each app's sandbox) | stripped when [`server/runtime.ts`](../server/runtime.ts) writes `worker.js` and `cresslet-runtime.js` into a run dir |
| `scripts/vendor/*.ts` | Node, esbuild | Node runs `build.ts`; esbuild bundles the entry files |

Stripping ([`server/strip.ts`](../server/strip.ts)) is Node's `module.stripTypeScriptTypes` in `strip` mode: types become
whitespace, so lines and columns are those of the source and stack traces and devtools need no source maps. It only
handles erasable syntax (no `enum`, `namespace`, parameter properties): every tsconfig sets `erasableSyntaxOnly`. Node 24
prints a one-time ExperimentalWarning for that function; `stripTypes` drops exactly that warning (no `--disable-warning`
flags anywhere).

## The studio's build

The studio is a TanStack Start app in SPA mode with hash routes (`#/p/<id>`): `studio/src/routes/` are the routes
(`src/routeTree.gen.ts` is generated from them; `npm run check` fails if it's stale), `studio/src/README.md` the
conventions its views follow. Nothing renders on a server: Start prerenders the shell once at build time, and the
Hono `/v1` API stays the only backend.

- **`npm run build`** writes `studio/dist/client`, which the server serves ([`server/studio.ts`](../server/studio.ts)):
  the shell for `/` with `no-cache`, `/assets/*` as `immutable`, the stable-URL files with `no-cache` (ETag), and
  cross-origin isolation (COOP/COEP/CORP) on everything, `frame-ancestors 'none'` on HTML. `npm start` needs it; the
  Docker image builds it in a build stage.
- **`npm run dev`** runs Vite in middleware mode inside the server (`CRESSLET_STUDIO_DEV=1`), so `/v1`, the app hosts
  and the preview host stay where they are; its hot-reload socket listens on `CRESSLET_HMR_PORT` (24678).
- **Earlier releases:** a CDN can keep a page past `no-cache`. A script that's gone (the old `/_v/<hash>/app.js` entry,
  or a hashed asset a later build replaced) answers with a module that reloads into `/?_r=<release>`, a URL no cached
  page has; the app drops `_r` again.

Tests that load studio modules under Node import [`tests/studio-imports.ts`](../tests/studio-imports.ts), which resolves
their `./x.js` imports to `x.ts`.

## tsconfigs

`npm run check` runs all of them, then the guard below.

| Config | Covers | Environment |
| --- | --- | --- |
| `tsconfig.json` | `server/`, `tests/*.ts`, `scripts/*.ts` | Node types |
| `studio/tsconfig.json` | the studio's page: `src/` (React, `jsx: react-jsx`) and the modules it imports, `vendor/*.d.ts` | DOM, `vite/client`, no Node |
| `studio/tsconfig.node.json` | `vite.config.ts` (the studio's build) | Node types |
| `studio/tsconfig.worker.json` | `server-worker.ts` | webworker lib |
| `studio/tsconfig.service.json` | `start-service.ts` | Node types; `types/tanstack.d.ts` |
| `runtime/tsconfig.json` | the sandbox entry | webworker lib + `runtime/workerd.d.ts` |
| `tests/e2e/tsconfig.json` | the browser e2e scripts | Node, Playwright (a root devDependency), `globals.d.ts` |
| `scripts/vendor/tsconfig.json` | the vendor bundles' build | needs `npm install` in `scripts/vendor`; run `npx tsc -p scripts/vendor` by hand |

All are `strict`, with `noImplicitOverride`, `noFallthroughCasesInSwitch`, `erasableSyntaxOnly` and
`verbatimModuleSyntax` (type-only imports say `import type`, so stripping removes them).

Bundles the studio loads have hand-written declarations next to them, typed for what the studio uses:
`studio/vendor/{editor,terminal,anthropic}.d.ts`; `vendor/cresslet-container` ships its own (`npm run vendor` also
writes `cresslet-container.d.ts`, so the bundle's file name resolves to them). API responses the studio reads are
typed in `studio/api-types.ts`; the page ↔ server-worker messages in `studio/server-worker-protocol.ts`.

## JavaScript that stays JavaScript

[`scripts/check-ts.ts`](../scripts/check-ts.ts) (in `npm run check`, so CI) fails on any `.js`/`.mjs`/`.cjs`/`.jsx` file
outside its allowlist:

- `studio/vendor/**`: generated bundles (scripts/vendor, `npm run vendor`, `npm run vendor:sdk`; the SDK is stripped from
  cresslet-cli's `sdk/index.ts`, or copied from an older `sdk/index.js`).
- `tests/fixtures/sdk-contract.js`: the SDK contract cases, vendored from cresslet-cli.
- `templates/**`: the starter apps users get (their code; not checked here).
- `studio/dist/**`: the studio's build output (not committed).

## Rules

- No `any` in code we own: `unknown` and narrowing, or a real type. An `any` only at a genuinely untyped boundary, with
  a comment saying so. (`Response.json()` and `JSON.parse` are typed `any` by the libs: give the result a type where it's
  used.)
- No `@ts-ignore` or `@ts-nocheck` (the guard fails on them); `@ts-expect-error` only with a reason.
- `!` only where an invariant guarantees the value (say which, briefly). In e2e scripts, `!` on a Playwright lookup the
  test expects to find is fine: a null fails the test as it did before.
- `as` on JSON at the edge and on `catch` values (`errorMessage(e)`); otherwise prefer types to casts (React refs
  are typed: `useRef<HTMLInputElement>(null)`).
- New fields must not change runtime behavior: a class field without an initializer is a real field in JavaScript; use
  `declare` for one that only exists for the types.

## Adding a file

- Server, scripts, tests: `foo.ts`, imported as `./foo.ts`.
- Studio UI: `studio/src/…/Foo.tsx` (a route in `studio/src/routes/`, a view in `studio/src/views/`), imported with its
  `.ts`/`.tsx` extension. A module that isn't UI: `studio/foo.ts`, imported as `./foo.js` by its neighbours. A file
  loaded by URL at runtime (not bundled): add it to `staticFiles` in `studio/vite.config.ts` and reference it with
  `staticUrl()` (`studio/static-url.ts`); add it to the tsconfig for where it runs if it isn't the page.
- A new environment: its own tsconfig, added to `npm run check`.
- Something that must stay JavaScript: add it to `ALLOW_JS` in `scripts/check-ts.ts`, with the reason.

## Commands

```sh
npm run check                # the route tree, every tsconfig, scripts/check-ts.ts
npm run build                # the studio (studio/dist)
npm test                     # includes tests/check_ts_test.ts
npx tsc -p studio            # one project
npx tsc -p scripts/vendor    # after npm install in scripts/vendor
```

## Follow-ups

- `noUncheckedIndexedAccess`: worth it, but it touches most indexing code.
- `noUnusedLocals` / `noUnusedParameters`.
- Templates in TypeScript throughout (some starter files are already `.ts`/`.tsx`).
- `tests/*_test.ts` call studio modules through untyped dynamic imports (the root program can't include the studio:
  different environment); a typed facade, or a test tsconfig per environment, would type those calls too.
- A typed `json<T>()` helper for tests and e2e scripts instead of `Response.json()`'s `any`.
