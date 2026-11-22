// Studio modules import each other by the names they're served under (`./start-build.js`: server/static.ts serves
// start-build.ts as JavaScript). Tests that load them under Node import this first: such an import then resolves to
// the .ts beside it (only in studio/, and only when there's no .js of that name).
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const STUDIO = new URL("../studio/", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(STUDIO) && /^\.\.?\/.*\.js$/.test(specifier)) {
      const js = new URL(specifier, context.parentURL);
      const ts = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (!existsSync(fileURLToPath(js)) && existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});
