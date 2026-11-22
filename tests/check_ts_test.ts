// scripts/check-ts.ts (npm run check): JavaScript only where allowed; no type-check opt-outs in our TypeScript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../scripts/check-ts.ts";

test("check-ts: flags JavaScript outside the allowlist and opt-out comments, nothing else", () => {
  const opt = "@ts-" + "nocheck"; // (spelled out, this file would fail the check)
  const text: Record<string, string> = {
    "server/x.ts": `// fine\nconst a = 1;\n// ${opt}\n`,
    "studio/y.ts": "// @ts-expect-error: a reason\n",
    "templates/react/src/z.ts": `// ${opt}\n`,
  };
  const files = ["studio/new.js", "tests/e2e/x.mjs", "studio/vendor/editor.js", "tests/fixtures/sdk-contract.js",
    "templates/vanilla/main.js", "scripts/vendor/node_modules/esbuild/lib/main.js", ...Object.keys(text)];
  assert.deepEqual(check(files, (f) => text[f] ?? ""), [
    "studio/new.js: JavaScript; write it in TypeScript (or allow it in scripts/check-ts.ts, with why)",
    "tests/e2e/x.mjs: JavaScript; write it in TypeScript (or allow it in scripts/check-ts.ts, with why)",
    `server/x.ts:3: ${opt}; fix the type error, or use @ts-expect-error with a reason`,
  ]);
});
