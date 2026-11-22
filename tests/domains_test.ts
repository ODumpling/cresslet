import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";
import { makeLegacyAnonymous } from "./owner.ts";

test("custom domains: DNS-verified, first verifier wins, routed, TLS ask endpoint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-dom-"));
  const txt = new Map<string, string[][]>();
  let duringLookup: (() => Promise<void>) | undefined;
  const srv = await createServer(loadConfig({
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

    assert.equal((await json("/v1")).body.customDomains, true);

    // Validation.
    assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: "null" })).status, 400);
    assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: JSON.stringify({ domain: "a".repeat(60) + "." + "b".repeat(60) + "." + "c".repeat(60) + "." + "d".repeat(60) + ".com" }) })).status, 400);
    for (const bad of ["localhost", "1.2.3.4", "x.test.local", "test.local", "-a.com", "a_b.com", "preview.test.local"]) {
      assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: JSON.stringify({ domain: bad }) })).status, 400, bad);
    }
    assert.equal((await json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: mallory, body: '{"domain":"x.com"}' })).status, 403);

    // At once: a repeat finds the first (not a 500), and the cap of 10 holds.
    const carol = { authorization: `Bearer ${await token("c@b.co")}` };
    const cApp = await deploy(carol, "carol");
    const add = (domain: string) => json(`/v1/apps/${cApp.name}/domains`, { method: "POST", headers: carol, body: JSON.stringify({ domain }) });
    const tries = await Promise.all([...Array.from({ length: 12 }, (_, i) => `d${i}.carol.example`), ..."xxx"].map((d) => add(d === "x" ? "same.carol.example" : d)));
    assert.deepEqual(tries.map((r) => r.status).filter((st) => st !== 201 && st !== 200 && st !== 400), []);
    assert.equal(tries.filter((r) => r.status === 201).length, 10);
    assert.equal((await json(`/v1/apps/${cApp.name}/domains`, { headers: carol })).body.domains.length, 10);

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
    // As Caddy asks it (deploy/caddy/Caddyfile): over the internal service name, not the public host.
    assert.equal((await call("/v1/domains/check?domain=shop.example.com", { host: "cresslet:8787" })).status, 200);
    assert.equal((await call("/v1/domains/check?domain=evil.com", { host: "cresslet:8787" })).status, 404);
    for (const covered of ["test.local", "preview.test.local", ""]) {
      assert.equal((await call(`/v1/domains/check?domain=${covered}`)).status, 404, covered);
    }

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
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("TLS ask endpoint: a preview host outside the wildcard needs its own certificate", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-dom-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", previewHost: "preview.other.example" }));
  const check = (d: string) => srv.handler(new Request(`http://cresslet:8787/v1/domains/check?domain=${d}`, { headers: { host: "cresslet:8787" } }));
  try {
    assert.equal((await check("preview.other.example")).status, 200);
    assert.equal((await check("other.example")).status, 404);
    assert.equal((await check("preview.test.local")).status, 404);
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CRESSLET_CUSTOM_DOMAINS=false: adding and verifying refused, reported in GET /v1, earlier domains keep routing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-dom-"));
  const start = async (customDomains: boolean) => {
    const srv = await createServer(loadConfig({
      dataDir,
      domain: "test.local",
      publicPort: 80,
      adminToken: "adm",
      customDomains,
      resolveTxt: async (name) => (name === "_cresslet.old.example.com" ? [[token]] : []),
    }));
    const json = async (path: string, init: RequestInit & { host?: string } = {}) => {
      const headers = new Headers(init.headers);
      headers.set("host", init.host ?? "test.local");
      if (init.body) headers.set("content-type", "application/json");
      const r = await srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
      return { status: r.status, text: await r.text() };
    };
    return { srv, json };
  };
  let token = "";
  let on = await start(true);
  try {
    // While on: a domain gets added and verified.
    const alice = { authorization: `Bearer ${JSON.parse((await on.json("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: '{"email":"a@b.co"}' })).text).token}` };
    const a = JSON.parse((await on.json("/v1/deploys", { method: "POST", headers: alice, body: JSON.stringify({ files: [{ path: "index.html", data: "alice" }] }) })).text).app;
    const added = JSON.parse((await on.json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: '{"domain":"old.example.com"}' })).text);
    token = added.domain.dns.find((r: { type: string }) => r.type === "TXT").value;
    assert.equal((await on.json(`/v1/apps/${a.name}/domains/old.example.com/verify`, { method: "POST", headers: alice })).status, 200);
    assert.equal((await on.json(`/v1/apps/${a.name}/domains`, { method: "POST", headers: alice, body: '{"domain":"pending.example.com"}' })).status, 201);
    await on.srv.close();

    // Turned off: the server says so, and refuses new domains and verification with a clear error.
    on = await start(false);
    assert.equal(JSON.parse((await on.json("/v1")).text).customDomains, false);
    for (const [path, body] of [[`/v1/apps/${a.name}/domains`, '{"domain":"new.example.com"}'], [`/v1/apps/${a.name}/domains/pending.example.com/verify`, undefined]] as const) {
      const r = await on.json(path, { method: "POST", headers: alice, body });
      assert.equal(r.status, 403, path);
      const err = JSON.parse(r.text);
      assert.equal(err.error, "custom_domains_disabled", r.text);
      assert.match(r.text, new RegExp(`custom domains are turned off on this server: use http://${a.name}\\.test\\.local`));
    }
    // Access is checked first: others get the usual refusal, not the setting.
    const mallory = { authorization: `Bearer ${JSON.parse((await on.json("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: '{"email":"m@b.co"}' })).text).token}` };
    for (const headers of [undefined, mallory]) {
      const r = await on.json(`/v1/apps/${a.name}/domains`, { method: "POST", headers, body: '{"domain":"new.example.com"}' });
      assert.equal(r.status, 403);
      assert.notEqual(JSON.parse(r.text).error, "custom_domains_disabled", r.text);
    }
    // An app without an owner (anonymous, from before every app needed one): its deploy key hears that domains are off.
    const anon = JSON.parse((await on.json("/v1/deploys", { method: "POST", headers: alice, body: JSON.stringify({ files: [{ path: "index.html", data: "anon" }] }) })).text);
    await makeLegacyAnonymous(on.srv.store, anon.app.id);
    const r = await on.json(`/v1/apps/${anon.app.name}/domains`, { method: "POST", headers: { "x-cresslet-deploy-key": anon.deployKey }, body: '{"domain":"new.example.com"}' });
    assert.equal(JSON.parse(r.text).error, "custom_domains_disabled", r.text);
    // Listing and removing still work, and the domain verified earlier still routes.
    const listed = JSON.parse((await on.json(`/v1/apps/${a.name}/domains`, { headers: alice })).text).domains.map((d: { domain: string; verified: boolean }) => [d.domain, d.verified]);
    assert.deepEqual(listed, [["old.example.com", true], ["pending.example.com", false]]);
    assert.equal((await on.json("/", { host: "old.example.com" })).text, "alice");
    assert.equal((await on.json("/v1/domains/check?domain=old.example.com")).status, 200);
    assert.equal((await on.json("/v1/domains/check?domain=pending.example.com")).status, 404);
    assert.equal((await on.json(`/v1/apps/${a.name}/domains/pending.example.com`, { method: "DELETE", headers: alice })).status, 200);
  } finally {
    await on.srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
