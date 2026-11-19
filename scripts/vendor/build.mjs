import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
const out = new URL("../../studio/vendor/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const name of ["editor", "terminal"]) {
  await build({ entryPoints: [`${name}.js`], bundle: true, format: "esm", minify: true, outfile: `${out}${name}.js`, legalComments: "eof" });
}
copyFileSync("node_modules/@xterm/xterm/css/xterm.css", `${out}xterm.css`);
console.log("vendored to", out);
