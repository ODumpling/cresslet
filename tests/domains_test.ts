import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";

test("custom domains: DNS-verified, first verifier wins, routed, TLS ask endpoint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-dom-"));
  const txt = new Map<string, string[][]>();
  let duringLookup: (() => Promise<void>) | undefined;
  const srv = createServer(loadConfig({
    dataDir,
    domain: "test.local",
    publicPort: 80,
    adminToken: "adm",
    resolveTxt: async (name) => {
      const r = txt.get(name);
      if (duringLookup) await duringLookup();
      if (!r) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return r;
    },
  }));
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  const json = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const r = await call(path, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const token = async (email: string) =>
      (await json("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: JSON.stringify({ email }) })).body.token;
    const alice = { authorization: `Bearer ${await token("a@b.co")}` };
    const mallory = { authorization: `Bearer ${await token("m@b.co")}` };
    const deploy = async (auth: Record<string, string>, html: string) =>
      (await json("/v1/deploys", { method: "POST", headers: auth, body: JSON.stringify({ files: [{ path: "index.html", data: html }] }) })).body.app;
    const a = await deploy(alice, "alice"), m = await deploy(mallory, "mallory");

    // Validation.
    assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: "null" })).status, 400);
    assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: JSON.stringify({ domain: "a".repeat(60) + "." + "b".repeat(60) + "." + "c".repeat(60) + "." + "d".repeat(60) + ".com" }) })).status, 400);
    for (const bad of ["localhost", "1.2.3.4", "x.test.local", "test.local", "-a.com", "a_b.com"]) {
      assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: JSON.stringify({ domain: bad }) })).status, 400, bad);
    }
    assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: mallory, body: '{"domain":"x.com"}' })).status, 403);

    // Both may add it (pending); only the one who proves DNS ownership gets it.
    const added = await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: '{"domain":"Shop.Example.com."}' });
    assert.equal(added.status, 201);
    assert.equal(added.body.domain.domain, "shop.example.com");
    assert.equal(added.body.domain.verified, false);
    const want = added.body.domain.dns.find((r: { type: string }) => r.type === "TXT");
    assert.equal(want.name, "_cresslet.shop.example.com");
    assert.deepEqual(added.body.domain.dns.find((r: { type: string }) => r.type === "CNAME").value, `${a.name}.test.local`);
    const squat = await json(`/v1/apps/${m.name}/domains`, { method: "POST", headers: mallory, body: '{"domain":"shop.example.com"}' });
    assert.equal(squat.status, 201);

    // Not routed or certifiable before verification.
    assert.equal((await call("/v1/domains/check?domain=shop.example.com")).status, 404);
    const before = await call("/", { host: "shop.example.com" });
    assert.ok(!(await before.text()).includes("alice"));

    assert.equal((await json(`/v1/apps/${a.name}/domains/shop.example.com/verify`, { method: "POST", headers: alice })).status, 400);
    txt.set("_cresslet.shop.example.com", [[want.value.slice(0, 10), want.value.slice(10)]]); // TXT split into chunks
    const ok = await json(`/v1/apps/${a.name}/domains/shop.example.com/verify`, { method: "POST", headers: alice });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.domain.verified, true);
    assert.equal(await (await call("/", { host: "shop.example.com" })).text(), "alice");
    assert.equal(await (await call("/", { host: "shop.example.com:8080" })).text(), "alice");
    assert.equal((await call("/v1/domains/check?domain=shop.example.com")).status, 200);
    assert.equal((await call("/v1/domains/check?domain=SHOP.example.com.")).status, 200);
    assert.equal(await (await call("/", { host: "shop.example.com.:8080" })).text(), "alice"); // trailing dot
    assert.equal((await call(`/v1/domains/check?domain=${a.name}.test.local`)).status, 404); // wildcard cert covers it
    assert.equal((await call("/v1/domains/check?domain=nope.test.local")).status, 404);
    assert.equal((await call("/v1/domains/check?domain=evil.com")).status, 404);

    // Mallory's pending entry can't be verified: her token isn't in DNS, and even if it were, it's taken.
    assert.equal((await json(`/v1/apps/${m.name}/domains/shop.example.com/verify`, { method: "POST", headers: mallory })).status, 400);
    const mtok = squat.body.domain.dns.find((r: { type: string }) => r.type === "TXT").value;
    txt.set("_cresslet.shop.example.com", [[want.value], [mtok]]);
    assert.equal((await json(`/v1/apps/${m.name}/domains/shop.example.com/verify`, { method: "POST", headers: mallory })).status, 409);
    assert.equal((await json(`/v1/apps/${m.name}/domains`, { method: "POST", headers: mallory, body: '{"domain":"other.example.com"}' })).status, 201);
    assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: '{"domain":"shop.example.com"}' })).status, 200);

    // Deleted and re-added while the TXT lookup runs: the old token must not verify the new row.
    const p1 = await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: '{"domain":"race.example.com"}' });
    txt.set("_cresslet.race.example.com", [[p1.body.domain.dns.find((r: { type: string }) => r.type === "TXT").value]]);
    duringLookup = async () => {
      duringLookup = undefined;
      await json(`/v1/apps/${a.name}/domains/race.example.com`, { method: "DELETE", headers: alice });
      await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: '{"domain":"race.example.com"}' });
    };
    assert.equal((await json(`/v1/apps/${a.name}/domains/race.example.com/verify`, { method: "POST", headers: alice })).status, 404);
    assert.equal((await call("/v1/domains/check?domain=race.example.com")).status, 404);

    // Removing it stops routing.
    await json(`/v1/apps/${a.name}/domains/Shop.Example.com.`, { method: "DELETE", headers: alice });
    assert.ok(!(await (await call("/", { host: "shop.example.com" })).text()).includes("alice"));
    assert.equal((await call("/v1/domains/check?domain=shop.example.com")).status, 404);
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
