# TypeScript

The code in this repo is TypeScript, type-checked strictly. There is no build step: everything runs from the `.ts`
sources, with types removed by Node's built-in type stripping where it runs, and by the server where it doesn't.

## How each part runs

| Code | Runs in | How it gets JavaScript |
| --- | --- | --- |
| `server/`, `scripts/*.ts`, `tests/*_test.ts`, `tests/e2e/*.ts` | Node 24 | Node's type stripping (`node server/main.ts`) |
| `studio/*.ts` | the browser (the page; `server-worker.ts` in a preview worker; `start-service.ts` in a container `node` process) | served stripped: a request for `studio/x.js` with no such file serves `x.ts` with its types removed, as `text/javascript` ([`server/static.ts`](../server/static.ts)) |
| `runtime/*.ts` | workerd (each app's sandbox) | stripped when [`server/runtime.ts`](../server/runtime.ts) writes `worker.js` and `cresslet-runtime.js` into a run dir |
| `scripts/vendor/*.ts` | Node, esbuild | Node runs `build.ts`; esbuild bundles the entry files |

Stripping ([`server/strip.ts`](../server/strip.ts)) is Node's `module.stripTypeScriptTypes` in `strip` mode: types become
whitespace, so lines and columns are those of the source and stack traces and devtools need no source maps. It only
handles erasable syntax (no `enum`, `namespace`, parameter properties): every tsconfig sets `erasableSyntaxOnly`. Node 24
prints a one-time ExperimentalWarning for that function; `stripTypes` drops exactly that warning (no `--disable-warning`
flags anywhere).

The studio's URLs and imports keep their `.js` names (`/app.js` in index.html, `import … from "./store.js"`,
`new URL("./server-worker.js", import.meta.url)`): that's what browsers, cached pages from earlier releases and
cresslet-container ask for. Stripped files are cached per file version (size + mtime, also the ETag), and the
`/_v/<hash>/` release hash covers the `.ts` sources. Tests that load studio modules under Node import
[`tests/studio-imports.ts`](../tests/studio-imports.ts), which resolves those `./x.js` imports to `x.ts`.

## tsconfigs

`npm run check` runs all of them, then the guard below.

| Config | Covers | Environment |
| --- | --- | --- |
| `tsconfig.json` | `server/`, `tests/*.ts`, `scripts/*.ts` | Node types |
| `studio/tsconfig.json` | the studio page modules, `vendor/*.d.ts` | DOM, no Node |
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

## Rules

- No `any` in code we own: `unknown` and narrowing, or a real type. An `any` only at a genuinely untyped boundary, with
  a comment saying so. (`Response.json()` and `JSON.parse` are typed `any` by the libs: give the result a type where it's
  used.)
- No `@ts-ignore` or `@ts-nocheck` (the guard fails on them); `@ts-expect-error` only with a reason.
- `!` only where an invariant guarantees the value (say which, briefly). In e2e scripts, `!` on a Playwright lookup the
  test expects to find is fine: a null fails the test as it did before.
- `as` on DOM lookups through the typed helper (`$<HTMLInputElement>("id")` in app.ts), on JSON at the edge, and on
  `catch` values (`errorMessage(e)`); otherwise prefer types to casts.
- New fields must not change runtime behavior: a class field without an initializer is a real field in JavaScript; use
  `declare` for one that only exists for the types.

## Adding a file

- Server, scripts, tests: `foo.ts`, imported as `./foo.ts`.
- Studio: `studio/foo.ts`, imported as `./foo.js` and referenced by that URL; add it to the tsconfig for where it runs if
  it isn't the page.
- A new environment: its own tsconfig, added to `npm run check`.
- Something that must stay JavaScript: add it to `ALLOW_JS` in `scripts/check-ts.ts`, with the reason.

## Commands

```sh
npm run check                # every tsconfig + scripts/check-ts.ts
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
