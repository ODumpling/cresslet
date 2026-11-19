// Copies clover-container's dist/ into studio/vendor/clover-container.
// Source: $CLOVER_CONTAINER_DIR, ../clover-container, or a shallow clone of GitHub main (or $CLOVER_CONTAINER_REF).
import { copy, exists } from "jsr:@std/fs@^1.0.0";
import { fromFileUrl, join } from "@std/path";

const root = fromFileUrl(new URL("..", import.meta.url));
const dest = join(root, "studio/vendor/clover-container");
let src = Deno.env.get("CLOVER_CONTAINER_DIR") ?? join(root, "../clover-container");

if (!(await exists(join(src, "dist")))) {
  src = await Deno.makeTempDir();
  const ref = Deno.env.get("CLOVER_CONTAINER_REF") ?? "main";
  const r = await new Deno.Command("git", {
    args: ["clone", "--depth", "1", "--branch", ref, "https://github.com/ODumpling/clover-container", src],
  }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
}
await Deno.remove(dest, { recursive: true }).catch(() => {});
await copy(join(src, "dist"), dest);
console.log(`vendored ${join(src, "dist")} → ${dest}`);
