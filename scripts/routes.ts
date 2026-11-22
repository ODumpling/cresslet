// The studio's route tree (studio/src/routeTree.gen.ts), generated from studio/src/routes by TanStack Start's Vite
// plugin, as `npm run dev` and `npm run build` do. `--check` (in npm run check): fail if the committed file was stale
// (it's rewritten, so commit the result).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

const STUDIO = join(import.meta.dirname, "../studio");
const TREE = join(STUDIO, "src/routeTree.gen.ts");
const before = await readFile(TREE, "utf8").catch(() => "");
// Creating the dev server runs the generator (it writes the tree once its routes are crawled).
const vite = await createServer({ configFile: join(STUDIO, "vite.config.ts"), root: STUDIO, logLevel: "warn", server: { middlewareMode: true, hmr: false, watch: null } });
await vite.environments.client.pluginContainer.buildStart({});
await vite.close();
const after = await readFile(TREE, "utf8");
if (process.argv.includes("--check") && after !== before) {
  console.error("routes: studio/src/routeTree.gen.ts was out of date with studio/src/routes; it's regenerated now, commit it");
  process.exit(1);
}
console.log(`routes: ${TREE.slice(STUDIO.length + 1)} up to date`);
