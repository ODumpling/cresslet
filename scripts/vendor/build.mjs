import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
const out = new URL("../../studio/vendor/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
// `node build.mjs anthropic` rebuilds just that one (editor.js carries hand patches: see its first line).
const names = process.argv.slice(2).length ? process.argv.slice(2) : ["editor", "terminal", "anthropic"];
for (const name of names) {
  await build({ entryPoints: [`${name}.js`], bundle: true, format: "esm", minify: true, outfile: `${out}${name}.js`, legalComments: "eof" });
}
copyFileSync("node_modules/@xterm/xterm/css/xterm.css", `${out}xterm.css`);
console.log("vendored to", out);
