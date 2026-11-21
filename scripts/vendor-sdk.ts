// Copies the `cresslet` SDK from cresslet-cli into studio/vendor/cresslet-sdk.js (the studio's virtual `cresslet`
// module, studio/cresslet-plugin.js) and its shared contract cases into tests/fixtures/sdk-contract.js (tests/sdk_test.ts).
// Source: $CRESSLET_CLI_DIR, ../cresslet-cli, or a shallow clone of GitHub main (or $CRESSLET_CLI_REF).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
let src = process.env.CRESSLET_CLI_DIR ?? join(root, "../cresslet-cli");
let clone: string | undefined;
if (process.env.CRESSLET_CLI_REF || !existsSync(join(src, "sdk/index.js"))) {
  src = clone = mkdtempSync(join(tmpdir(), "cresslet-cli-"));
  const ref = process.env.CRESSLET_CLI_REF ?? "main";
  execFileSync("git", ["clone", "--depth", "1", "--branch", ref, "https://github.com/ODumpling/cresslet-cli", src], { stdio: "inherit" });
}
for (const [from, to] of [["sdk/index.js", "studio/vendor/cresslet-sdk.js"], ["test/contract/app.js", "tests/fixtures/sdk-contract.js"]]) {
  copyFileSync(join(src, from), join(root, to));
  console.log(`vendored ${join(src, from)} → ${to}`);
}
if (clone) rmSync(clone, { recursive: true, force: true });
