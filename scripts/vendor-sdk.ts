// Copies the `cresslet` SDK from cresslet-cli into studio/vendor/cresslet-sdk.js (the studio's virtual `cresslet`
// module, studio/cresslet-plugin.ts) and its shared contract cases into tests/fixtures/sdk-contract.js (tests/sdk_test.ts).
// The SDK is sdk/index.ts there (self-contained, erasable TypeScript: vendored with its types stripped) or, in older
// checkouts, sdk/index.js (copied).
// Source: $CRESSLET_CLI_DIR, ../cresslet-cli, or a shallow clone of GitHub main (or $CRESSLET_CLI_REF).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypes } from "../server/strip.ts";

const root = join(import.meta.dirname, "..");
let src = process.env.CRESSLET_CLI_DIR ?? join(root, "../cresslet-cli");
let clone: string | undefined;
const hasSdk = (dir: string) => existsSync(join(dir, "sdk/index.ts")) || existsSync(join(dir, "sdk/index.js"));
if (process.env.CRESSLET_CLI_REF || !hasSdk(src)) {
  src = clone = mkdtempSync(join(tmpdir(), "cresslet-cli-"));
  process.on("exit", () => rmSync(clone!, { recursive: true, force: true })); // a failed clone too
  const ref = process.env.CRESSLET_CLI_REF ?? "main";
  execFileSync("git", ["clone", "--depth", "1", "--branch", ref, "https://github.com/ODumpling/cresslet-cli", src], { stdio: "inherit" });
}
try {
  const sdkTs = join(src, "sdk/index.ts");
  if (existsSync(sdkTs)) {
    writeFileSync(join(root, "studio/vendor/cresslet-sdk.js"), stripTypes(readFileSync(sdkTs, "utf8")));
    console.log(`vendored ${sdkTs} (types stripped) → studio/vendor/cresslet-sdk.js`);
  } else {
    copyFileSync(join(src, "sdk/index.js"), join(root, "studio/vendor/cresslet-sdk.js"));
    console.log(`vendored ${join(src, "sdk/index.js")} → studio/vendor/cresslet-sdk.js`);
  }
  copyFileSync(join(src, "test/contract/app.js"), join(root, "tests/fixtures/sdk-contract.js"));
  console.log(`vendored ${join(src, "test/contract/app.js")} → tests/fixtures/sdk-contract.js`);
} finally {
  if (clone) rmSync(clone, { recursive: true, force: true });
}
