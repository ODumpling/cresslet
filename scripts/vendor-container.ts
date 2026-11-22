// Copies cresslet-container's dist/ into studio/vendor/cresslet-container.
// Source: $CRESSLET_CONTAINER_DIR, ../cresslet-container, or a shallow clone of GitHub main (or $CRESSLET_CONTAINER_REF).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dest = join(root, "studio/vendor/cresslet-container");
let src = process.env.CRESSLET_CONTAINER_DIR ?? join(root, "../cresslet-container");

if (!existsSync(join(src, "dist"))) {
  src = mkdtempSync(join(tmpdir(), "cresslet-container-"));
  const ref = process.env.CRESSLET_CONTAINER_REF ?? "main";
  execFileSync("git", ["clone", "--depth", "1", "--branch", ref, "https://github.com/ODumpling/cresslet-container", src], {
    stdio: "inherit",
  });
}
rmSync(dest, { recursive: true, force: true });
cpSync(join(src, "dist"), dest, { recursive: true });
// The studio imports the bundle by its file name (cresslet-container.js): its types, next to it (studio/tsconfig.json).
writeFileSync(join(dest, "cresslet-container.d.ts"), '// Written by scripts/vendor-container.ts: the types of the bundle beside it (studio/tsconfig.json).\nexport * from "./index";\n');
console.log(`vendored ${join(src, "dist")} → ${dest}`);
