// Part of `npm run check` (docs/typescript.md): the code we own is TypeScript. Fails on a .js/.mjs/.cjs/.jsx file
// outside ALLOW_JS, or a type-check opt-out comment in our own TypeScript.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** JavaScript that stays JavaScript, and why. */
export const ALLOW_JS: [RegExp, string][] = [
  [/^studio\/vendor\/(?:editor|terminal|anthropic)\.js$/, "vendored bundles built by scripts/vendor"],
  [/^studio\/vendor\/cresslet-container\//, "cresslet-container's dist, vendored by npm run vendor"],
  [/^studio\/vendor\/cresslet-sdk\.js$/, "the cresslet SDK, vendored from cresslet-cli by npm run vendor:sdk"],
  [/^tests\/fixtures\/sdk-contract\.js$/, "the SDK's shared contract cases, vendored from cresslet-cli by npm run vendor:sdk"],
  [/^templates\//, "starter apps users get (their own code, whatever they write it in)"],
  [/^studio\/dist\//, "the studio's build output (npm run build; not committed)"],
];

/** Not our code to police: vendored type declarations, the templates, and the generated route tree (TanStack's). */
const FOREIGN_TS = [/^studio\/vendor\/cresslet-container\//, /^templates\//, /^studio\/src\/routeTree\.gen\.ts$/];

const JS = /\.(?:js|mjs|cjs|jsx)$/;
const TS = /\.(?:ts|tsx|mts|cts)$/;
// Built from parts, so this file doesn't trip its own check.
const OPT_OUT = new RegExp(`@ts-${"(?:ignore|nocheck)"}\\b`);
/** `@ts-expect-error` with no reason after it (only the comment's end, maybe then code): after //, ///, /*, /**, or
 * starting a block comment's line. */
const BARE_EXPECT_ERROR = new RegExp(`(?:///?|/\\*+|^\\s*\\**)\\s*@ts-${"expect-error"}\\s*(?:\\*+/.*)?$`);

/** Every problem with these repo-relative paths (`read`: a file's text). */
export function check(files: string[], read: (path: string) => string): string[] {
  const problems: string[] = [];
  for (const f of files) {
    if (f.split("/").includes("node_modules")) continue;
    if (JS.test(f) && !ALLOW_JS.some(([re]) => re.test(f))) problems.push(`${f}: JavaScript; write it in TypeScript (or allow it in scripts/check-ts.ts, with why)`);
    if (TS.test(f) && !FOREIGN_TS.some((re) => re.test(f))) {
      const lines = read(f).split(/\r?\n/);
      lines.forEach((l, i) => {
        if (OPT_OUT.test(l)) problems.push(`${f}:${i + 1}: ${OPT_OUT.exec(l)![0]}; fix the type error, or use @ts-expect-error with a reason`);
        if (BARE_EXPECT_ERROR.test(l)) problems.push(`${f}:${i + 1}: @ts-expect-error needs a reason after it`);
      });
    }
  }
  return problems;
}

if (process.argv[1] === import.meta.filename) {
  const root = join(import.meta.dirname, "..");
  // Tracked files and new ones not ignored (ones deleted but not yet staged are skipped).
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter((f) => f && existsSync(join(root, f)));
  const problems = check(files, (f) => readFileSync(join(root, f), "utf8"));
  for (const p of problems) console.error(`check-ts: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`check-ts: ${files.length} files, all TypeScript (${ALLOW_JS.length} allowed JavaScript locations)`);
}
