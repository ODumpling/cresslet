// Copies cresslet-container's dist/ into studio/vendor/cresslet-container.
// Source: $CRESSLET_CONTAINER_DIR, ../cresslet-container, or a shallow clone of GitHub main (or $CRESSLET_CONTAINER_REF).
import { copy, exists } from "jsr:@std/fs@^1.0.0";
import { fromFileUrl, join } from "@std/path";

const root = fromFileUrl(new URL("..", import.meta.url));
const dest = join(root, "studio/vendor/cresslet-container");
let src = Deno.env.get("CRESSLET_CONTAINER_DIR") ?? join(root, "../cresslet-container");

if (!(await exists(join(src, "dist")))) {
  src = await Deno.makeTempDir();
  const ref = Deno.env.get("CRESSLET_CONTAINER_REF") ?? "main";
  const r = await new Deno.Command("git", {
    args: ["clone", "--depth", "1", "--branch", ref, "https://github.com/ODumpling/cresslet-container", src],
  }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
}
await Deno.remove(dest, { recursive: true }).catch(() => {});
await copy(join(src, "dist"), dest);
console.log(`vendored ${join(src, "dist")} → ${dest}`);
