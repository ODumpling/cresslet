// The studio's built files as the server serves them (server/studio.ts): headers on every response, caching (the
// shell revalidates, hashed assets are immutable), and pages from an earlier release reloading into this one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { studio } from "../server/studio.ts";

const SHELL = '<!DOCTYPE html><html><head><script type="module" src="/assets/index-abc123.js"></script></head><body></body></html>';

async function built() {
  const dist = await mkdtemp(join(tmpdir(), "cresslet-studio-"));
  await mkdir(join(dist, "assets"));
  await mkdir(join(dist, "vendor/cresslet-container"), { recursive: true });
  await writeFile(join(dist, "_shell.html"), SHELL);
  await writeFile(join(dist, "assets/index-abc123.js"), "export {};");
  await writeFile(join(dist, "assets/index-abc123.css"), "body{}");
  await writeFile(join(dist, "server-worker.js"), "self.x = 1;");
  await writeFile(join(dist, "vendor/cresslet-container/node-worker.js"), "self.y = 1;");
  return dist;
}
const get = (s: Awaited<ReturnType<typeof studio>>, path: string, init?: RequestInit) => s.serve(new Request(`http://localhost${path}`, init)).then((r) => r!);
const isolated = (r: Response) => {
  assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(r.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
};

test("studio: the shell at / revalidates, can't be framed, and is cross-origin isolated", async () => {
  const dist = await built();
  try {
    const s = await studio({ dist });
    for (const path of ["/", "/index.html", "/?_r=abc"]) {
      const r = await get(s, path);
      assert.equal(r.status, 200);
      assert.equal(await r.text(), SHELL);
      assert.equal(r.headers.get("cache-control"), "no-cache");
      assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'none'");
      assert.match(r.headers.get("content-type")!, /^text\/html/);
      isolated(r);
    }
    const head = await get(s, "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("studio: a page load of a route's path gets the shell; anything else asking for a missing file, a 404", async () => {
  const dist = await built();
  try {
    const s = await studio({ dist });
    const html = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
    for (const path of ["/artifacts", "/p/abc", "/view/pg-1?path=%2Fx", "/apps/a/database/t.x", "/no-such-route"]) {
      const r = await get(s, path, { headers: html });
      assert.equal(r.status, 200, path);
      assert.equal(await r.text(), SHELL);
      assert.equal(r.headers.get("cache-control"), "no-cache");
      assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'none'");
      assert.equal(r.headers.get("vary"), "accept");
      isolated(r);
    }
    assert.equal((await get(s, "/settings", { method: "HEAD", headers: html })).status, 200);
    // Not a page load (a script, an image, fetch), or a write: no shell.
    for (const [path, init] of [["/artifacts", {}], ["/nope.png", { headers: { accept: "image/*" } }], ["/settings", { method: "POST", headers: html }]] as const) {
      const r = await get(s, path, init);
      assert.equal(r.status, 404, path);
      assert.equal(r.headers.get("vary"), "accept");
    }
    // Files are still files, whatever the request asks for; an old release's path isn't a route.
    assert.equal(await (await get(s, "/server-worker.js", { headers: html })).text(), "self.x = 1;");
    assert.equal((await get(s, "/_v/0123abcd4567/styles.css", { headers: html })).status, 404);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("studio: hashed assets are immutable; stable-URL files revalidate; all isolated", async () => {
  const dist = await built();
  try {
    const s = await studio({ dist });
    const js = await get(s, "/assets/index-abc123.js");
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
    isolated(js);
    for (const path of ["/server-worker.js", "/vendor/cresslet-container/node-worker.js"]) {
      const r = await get(s, path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get("cache-control"), "no-cache");
      assert.match(r.headers.get("content-type")!, /^text\/javascript/);
      isolated(r);
    }
    const missing = await get(s, "/nope.txt");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-cache");
    isolated(missing);
    // Outside the build: not served.
    assert.equal((await get(s, "/../package.json")).status, 404);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("studio: a page from an earlier release reloads into this one", async () => {
  const dist = await built();
  try {
    const s = await studio({ dist });
    // The pre-build scheme's entry module, and a hashed script a later build replaced: a reload to /?_r=<release>.
    for (const path of ["/_v/0123abcd4567/app.js", "/assets/index-old999.js"]) {
      const r = await get(s, path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get("content-type")!, /^text\/javascript/);
      assert.equal(r.headers.get("cache-control"), "no-store");
      isolated(r);
      const code = await r.text();
      const release = /searchParams\.set\("_r", "([0-9a-f]{12})"\)/.exec(code)?.[1];
      assert.ok(release, code);
      // It reloads once, and stops if it's already at this release's URL (a cache that ignores the query too).
      const run = (href: string) => {
        let to: string | null = null;
        new Function("location", "console", code)({ href, replace: (u: string) => (to = u) }, { error() {} });
        return to;
      };
      assert.equal(run("http://localhost/p/abc?x=1"), `/p/abc?x=1&_r=${release}`);
      assert.equal(run(`http://localhost/p/abc?_r=${release}`), null);
    }
    // Anything else an old page asks for under /_v/ comes from this release, if it's still at that URL.
    const worker = await get(s, "/_v/0123abcd4567/server-worker.js");
    assert.equal(worker.status, 200);
    assert.equal(await worker.text(), "self.x = 1;");
    assert.equal((await get(s, "/_v/0123abcd4567/styles.css")).status, 404);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("studio: not built yet: a 503 that says how", async () => {
  const dist = await mkdtemp(join(tmpdir(), "cresslet-studio-"));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await get(await studio({ dist }), "/");
    assert.equal(r.status, 503);
    assert.match(await r.text(), /npm run build/);
  } finally {
    console.warn = warn;
    await rm(dist, { recursive: true, force: true });
  }
});
