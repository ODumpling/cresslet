import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";
import { cronMatches, CronRuns, nextRuns, normalizeCrons, parseCron, Scheduler } from "../server/cron.ts";

const at = (iso: string) => new Date(iso);
const matches = (expr: string, iso: string) => cronMatches(parseCron(expr), at(iso));

test("cron expressions", () => {
  assert.ok(matches("* * * * *", "2026-11-19T10:07:00Z"));
  assert.ok(matches("*/5 * * * *", "2026-11-19T10:05:00Z"));
  assert.ok(!matches("*/5 * * * *", "2026-11-19T10:07:00Z"));
  assert.ok(matches("0 9-17 * * 1-5", "2026-11-19T12:00:00Z")); // Thursday
  assert.ok(!matches("0 9-17 * * 1-5", "2026-11-21T12:00:00Z")); // Saturday
  assert.ok(matches("30 2 * * 0", "2026-11-22T02:30:00Z") && matches("30 2 * * 7", "2026-11-22T02:30:00Z")); // Sunday
  assert.ok(matches("0 0 1,15 * *", "2026-11-15T00:00:00Z"));
  // Both day fields restricted: either matches (standard cron).
  assert.ok(matches("0 0 1 * 1", "2026-11-23T00:00:00Z")); // a Monday, not the 1st
  // A day field starting with * counts as unrestricted (Vixie): then both must match.
  assert.ok(matches("0 0 */2 * 1", "2026-11-23T00:00:00Z")); // Monday the 23rd (odd)
  assert.ok(!matches("0 0 */2 * 1", "2026-11-16T00:00:00Z")); // Monday the 16th (even)
  assert.ok(!matches("0 0 */2 * 1", "2026-11-19T00:00:00Z")); // odd, but Thursday
  assert.ok(matches("0 0 1-31 * 1", "2026-11-19T00:00:00Z")); // explicit 1-31 is restricted: either matches
  assert.ok(matches("0 9 * * MON-FRI", "2026-11-20T09:00:00Z") && !matches("0 9 * * mon-fri", "2026-11-22T09:00:00Z"));
  assert.ok(matches("0 0 1 JAN *", "2027-01-01T00:00:00Z"));
  assert.ok(matches("10-20/5 * * * *", "2026-11-19T10:15:00Z") && !matches("10-20/5 * * * *", "2026-11-19T10:25:00Z"));
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"]) {
    assert.throws(() => parseCron(bad), Error, bad);
  }
  assert.deepEqual(normalizeCrons([" */5  *  * * * ", "*/5 * * * *"]), ["*/5 * * * *"]);
  assert.doesNotThrow(() => parseCron(Array.from({ length: 60 }, (_, i) => i).join(",") + " * * * *"));
  assert.throws(() => normalizeCrons(Array(6).fill("* * * * *")));
});

test("next runs", () => {
  const next = (expr: string, from: string, n = 3) => nextRuns(parseCron(expr), Date.parse(from), n).map((t) => new Date(t).toISOString().slice(0, 16));
  assert.deepEqual(next("*/5 * * * *", "2026-11-19T10:05:00Z"), ["2026-11-19T10:10", "2026-11-19T10:15", "2026-11-19T10:20"]); // strictly after
  assert.deepEqual(next("*/5 * * * *", "2026-11-19T10:07:30Z", 1), ["2026-11-19T10:10"]);
  assert.deepEqual(next("0 9 * * MON-FRI", "2026-11-20T09:30:00Z", 2), ["2026-11-23T09:00", "2026-11-24T09:00"]); // Fri → Mon
  assert.deepEqual(next("0 0 1 JAN *", "2026-11-19T00:00:00Z", 1), ["2027-01-01T00:00"]);
  assert.deepEqual(next("0 0 29 2 *", "2026-03-01T00:00:00Z", 1), ["2028-02-29T00:00"]);
  assert.deepEqual(next("0 0 30 2 *", "2026-03-01T00:00:00Z"), []); // never
  assert.deepEqual(next("0 0 29 2 */7", "2088-03-01T00:00:00Z", 1), ["2128-02-29T00:00"]); // past 2100's missing leap day
  assert.deepEqual(next("0 0 1 * 1", "2026-11-19T00:00:00Z", 2), ["2026-11-23T00:00", "2026-11-30T00:00"]); // either day field
  // Matches cronMatches minute by minute over a stretch.
  for (const expr of ["7,37 */3 * * *", "0 0 */2 * 1", "15 10 1-7 * SUN", "*/13 * * * *"]) {
    const c = parseCron(expr), from = Date.parse("2026-11-19T00:00:00Z");
    const brute: number[] = [];
    for (let t = from + 60_000; brute.length < 5; t += 60_000) if (cronMatches(c, new Date(t))) brute.push(t);
    assert.deepEqual(nextRuns(c, from, 5), brute, expr);
  }
});

test("each cron's last run outlives the recent runs; old crons' are let go", () => {
  const r = new CronRuns();
  const run = (cron: string) => r.record("app_1", { cron, at: 0, startedAt: 0, ms: 1, status: 200, manual: false });
  run("0 3 * * *");
  for (let i = 0; i < 60; i++) run("* * * * *");
  assert.equal(r.list("app_1").length, CronRuns.KEEP);
  assert.ok(!r.list("app_1").some((x) => x.cron === "0 3 * * *"));
  assert.equal(r.last("app_1", "0 3 * * *")?.cron, "0 3 * * *");
  for (let i = 0; i < CronRuns.KEEP_LAST; i++) run(`${i} 1 * * *`);
  assert.equal(r.last("app_1", "0 3 * * *"), undefined);
  assert.equal(r.last("app_1", "* * * * *"), undefined);
  assert.ok(r.last("app_1", `${CronRuns.KEEP_LAST - 1} 1 * * *`));
});

test("a paused cron doesn't fire on schedule; Run now runs it once, queued behind the app's other runs", async () => {
  const ran: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const app = { id: "app_1", config: JSON.stringify({ crons: ["* * * * *", "*/2 * * * *"] }), paused_crons: JSON.stringify(["*/2 * * * *"]) };
  const s = new Scheduler({ appsWithCrons: () => [app] } as never, async (_a, c, _at, manual) => {
    ran.push(`${c}${manual ? " manual" : ""}`);
    if (!manual) await slow;
  });
  const t = s.tick(new Date("2026-11-19T10:02:00Z"));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.state("app_1", "* * * * *"), "running");
  assert.ok(s.runNow("app_1", "*/2 * * * *"));
  assert.equal(s.state("app_1", "*/2 * * * *"), "queued");
  assert.ok(!s.runNow("app_1", "*/2 * * * *")); // already queued
  assert.ok(!s.runNow("app_1", "* * * * *")); // already running
  release();
  await t;
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(ran, ["* * * * *", "*/2 * * * * manual"]);
  assert.equal(s.state("app_1", "*/2 * * * *"), null);
});

const SERVER = `
export default {
  async fetch(req, env) {
    await env.db.exec("CREATE TABLE IF NOT EXISTS runs (cron TEXT, t INTEGER)");
    return Response.json(await env.db.query("SELECT * FROM runs"));
  },
  async scheduled(event, env) {
    await env.db.exec("CREATE TABLE IF NOT EXISTS runs (cron TEXT, t INTEGER)");
    await env.db.run("INSERT INTO runs VALUES (?, ?)", event.cron, event.scheduledTime);
  },
};`;

test("crons run the scheduled() export of claimed apps", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-cron-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm" }));
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  srv.scheduler.stop(); // the test drives ticks itself
  try {
    const deploy = (extra: Record<string, unknown>) =>
      call("/v1/deploys", { method: "POST", body: JSON.stringify({ files: [{ path: "index.html", data: "x" }], ...extra }) });
    assert.equal((await deploy({ server: SERVER, config: { crons: ["nope"] } })).status, 400);
    assert.equal((await deploy({ config: { crons: ["* * * * *"] } })).status, 400); // no server
    const d = await (await deploy({ server: SERVER, config: { crons: ["*/5 * * * *", "0 3 * * *"] } })).json();
    const host = `${d.app.name}.test.local`;
    const runs = async () => (await call("/api/runs", { host })).json();

    // Unclaimed: not scheduled, and no Run now.
    await srv.scheduler.tick(at("2026-11-19T10:05:00Z"));
    assert.deepEqual(await runs(), []);
    const early = await call(`/v1/apps/${d.app.name}/crons/run`, { method: "POST", headers: { "x-cresslet-deploy-key": d.deployKey }, body: '{"cron":"0 3 * * *"}' });
    assert.equal(early.status, 403);

    const acct = await (await call("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: '{"email":"a@b.co"}' })).json();
    await call(`/v1/apps/${d.app.name}/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${acct.token}` },
      body: JSON.stringify({ deployKey: d.deployKey }),
    });
    await srv.scheduler.tick(at("2026-11-19T10:05:00Z"));
    await srv.scheduler.tick(at("2026-11-19T10:07:00Z")); // nothing due
    await srv.scheduler.tick(at("2026-11-20T03:00:00Z")); // both due
    assert.deepEqual(await runs(), [
      { cron: "*/5 * * * *", t: Date.parse("2026-11-19T10:05:00Z") },
      { cron: "*/5 * * * *", t: Date.parse("2026-11-20T03:00:00Z") },
      { cron: "0 3 * * *", t: Date.parse("2026-11-20T03:00:00Z") },
    ]);
    const logs = srv.runtime.logs.recent(d.app.id, 100).map((l) => l.msg).join("\n");
    assert.match(logs, /cron "\*\/5 \* \* \* \*" ok/);

    // The studio's view: schedule, next runs, last run; pause, resume and Run now.
    const auth = { authorization: `Bearer ${acct.token}` };
    const crons = async () => (await call(`/v1/apps/${d.app.name}/crons`, { headers: auth })).json();
    const post = (path: string, cron: unknown, headers: Record<string, string> = auth) =>
      call(`/v1/apps/${d.app.name}/crons/${path}`, { method: "POST", headers, body: JSON.stringify({ cron }) });
    let v = await crons();
    assert.deepEqual(v.crons.map((x: { cron: string; paused: boolean }) => [x.cron, x.paused]), [["*/5 * * * *", false], ["0 3 * * *", false]]);
    assert.equal(v.crons[0].next.length, 3);
    assert.equal(v.crons[0].last.at, "2026-11-20T03:00:00.000Z");
    assert.equal(v.crons[0].last.ok, true);
    assert.equal(v.runs.length, 3);
    assert.equal((await post("pause", "nope")).status, 404);
    v = await (await post("pause", "0 3 * * *")).json();
    assert.equal(v.crons[1].paused, true);
    assert.deepEqual(v.crons[1].next, []);
    await srv.scheduler.tick(at("2026-11-21T03:00:00Z")); // only */5
    assert.equal((await runs()).length, 4);
    assert.ok(!(await runs()).some((r: { t: number; cron: string }) => r.cron === "0 3 * * *" && r.t === Date.parse("2026-11-21T03:00:00Z")));
    // Run now runs a paused cron.
    assert.equal((await post("run", "0 3 * * *")).status, 202);
    for (let i = 0; i < 100 && (await runs()).length < 5; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await runs()).length, 5);
    v = await crons();
    assert.equal(v.runs[0].manual, true);
    assert.equal(v.crons[1].last.manual, true);
    v = await (await post("resume", "0 3 * * *")).json();
    assert.equal(v.crons[1].paused, false);
    // Deploy-key callers may; read-only tokens may not.
    const ro = await (await call("/v1/me/tokens", { method: "POST", headers: auth, body: JSON.stringify({ name: "ro", role: "read" }) })).json();
    assert.equal((await post("pause", "0 3 * * *", { authorization: `Bearer ${ro.token}` })).status, 403);
    assert.equal((await call(`/v1/apps/${d.app.name}/crons`, { headers: { authorization: `Bearer ${ro.token}` } })).status, 200);
    assert.equal((await post("pause", "0 3 * * *", { "x-cresslet-deploy-key": d.deployKey })).status, 200);
    // Paused stays paused across a redeploy that keeps the cron.
    await call("/v1/deploys", { method: "POST", headers: auth, body: JSON.stringify({ app: d.app.name, files: [{ path: "index.html", data: "x" }], server: SERVER, config: { crons: ["0 3 * * *"] } }) });
    v = await crons();
    assert.deepEqual(v.crons.map((x: { cron: string; paused: boolean }) => [x.cron, x.paused]), [["0 3 * * *", true]]);
    assert.equal(v.crons[0].last.manual, true); // its last run, though */5 runs were newer
    // A deploy without it forgets the pause: brought back, it runs.
    const redeploy = (crons: string[]) => call("/v1/deploys", { method: "POST", headers: auth, body: JSON.stringify({ app: d.app.name, files: [{ path: "index.html", data: "x" }], server: SERVER, config: { crons } }) });
    await redeploy(["*/5 * * * *"]);
    await redeploy(["0 3 * * *"]);
    assert.equal((await crons()).crons[0].paused, false);
    assert.equal((await call(`/v1/apps/${d.app.name}/crons/pause`, { method: "POST", headers: auth, body: "null" })).status, 404);

    // Clients can't trigger scheduled() by forging the internal header.
    const forged = await call("/api/runs", { host, headers: { "x-cresslet-scheduled": '{"cron":"forged","scheduledTime":1}' } });
    assert.equal(forged.status, 200);
    assert.ok(!(await forged.json()).some((r: { cron: string }) => r.cron === "forged"));

    // Delete only the app the caller looked at.
    assert.equal((await call(`/v1/apps/${d.app.name}?id=app_other`, { method: "DELETE", headers: auth })).status, 409);
    assert.equal((await call(`/v1/apps/${d.app.name}?id=${d.app.id}`, { method: "DELETE", headers: auth })).status, 200);
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("scheduler fires each minute once, catches up after a stall, never repeats a minute", () => {
  const T = (hm: string) => Date.parse(`2026-11-19T${hm}Z`);
  const s = new Scheduler({} as never, async () => {}, T("10:00:59.980"));
  const due = (hm: string) => s.due(T(hm)).map((m) => new Date(m).toISOString().slice(11, 16));
  assert.deepEqual(due("10:01:00.050"), ["10:01"]);
  assert.deepEqual(due("10:01:00.300"), []); // same minute again (timer drift)
  assert.deepEqual(due("10:03:30"), ["10:02", "10:03"]); // late callback: skipped minute still fires
  assert.deepEqual(due("10:02:10"), []); // clock stepped back
  assert.deepEqual(due("10:04:00.050"), ["10:04"]);
  assert.deepEqual(due("11:00:00.050"), ["10:56", "10:57", "10:58", "10:59", "11:00"]); // bounded catch-up
});

test("catch-up minutes all run, in order", async () => {
  const ran: string[] = [];
  const store = { appsWithCrons: () => [{ id: "app_1", config: JSON.stringify({ crons: ["* * * * *", "*/2 * * * *"] }) }] };
  const s = new Scheduler(store as never, async (_a, c, at) => void ran.push(`${c}@${at.toISOString().slice(14, 16)}`));
  await s.tick(["10:01", "10:02", "10:03"].map((m) => new Date(`2026-11-19T${m}:00Z`)));
  assert.deepEqual(ran, ["* * * * *@01", "* * * * *@02", "*/2 * * * *@02", "* * * * *@03"]);
});

test("a cron that finished isn't skipped while another cron of the app is still running", async () => {
  const ran: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const store = { appsWithCrons: () => [{ id: "app_1", config: JSON.stringify({ crons: ["* * * * *", "*/2 * * * *"] }) }] };
  const s = new Scheduler(store as never, async (_a, c, at) => {
    ran.push(`${c}@${at.toISOString().slice(14, 16)}`);
    if (c === "*/2 * * * *") await slow;
  });
  const t1 = s.tick(new Date("2026-11-19T10:02:00Z")); // `*` runs, then `*/2` hangs
  await new Promise((r) => setTimeout(r, 10));
  const t2 = s.tick(new Date("2026-11-19T10:03:00Z")); // `*` must still be queued
  release();
  await Promise.all([t1, t2]);
  assert.deepEqual(ran, ["* * * * *@02", "*/2 * * * *@02", "* * * * *@03"]);
});

test("due crons of one app run one at a time with their own timeout; waitUntil failures count", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-cron-"));
  const srv = await createServer(loadConfig({ dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", limits: { requestMs: 1500 } as never }));
  srv.scheduler.stop();
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://${init.host ?? "test.local"}${path}`, { ...init, headers }));
  };
  try {
    const acct = await (await call("/v1/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: '{"email":"a@b.co"}' })).json();
    const auth = { authorization: `Bearer ${acct.token}` };
    // A failing static-only cron deploy for an existing app leaves nothing on disk.
    const d = await (await call("/v1/deploys", { method: "POST", headers: auth, body: JSON.stringify({ files: [{ path: "index.html", data: "x" }] }) })).json();
    const before = await readdir(join(dataDir, "apps", d.app.id, "deploys"));
    const bad = await call("/v1/deploys", { method: "POST", headers: auth, body: JSON.stringify({ app: d.app.name, files: [{ path: "index.html", data: "x" }], config: { crons: ["* * * * *"] } }) });
    assert.equal(bad.status, 400);
    assert.deepEqual(await readdir(join(dataDir, "apps", d.app.id, "deploys")), before);

    await call("/v1/deploys", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        app: d.app.name,
        files: [{ path: "index.html", data: "x" }],
        config: { crons: ["* * * * *", "*/2 * * * *", "0 * * * *"] },
        server: `export default {
          fetch() { return new Response("x") },
          async scheduled(e, env, ctx) {
            if (e.cron === "0 * * * *") {
              ctx.waitUntil(Promise.reject(new Error("late failure")));
              ctx.waitUntil(new Promise((r) => setTimeout(r, 200)).then(() =>
                ctx.waitUntil(new Promise((r) => setTimeout(r, 100)).then(() => env.db.exec("CREATE TABLE IF NOT EXISTS finished (x)")))));
              return;
            }
            await new Promise((r) => setTimeout(r, 1000));
          },
        };`,
      }),
    });
    await srv.scheduler.tick(new Date("2026-11-19T10:00:00Z"));
    const logs = srv.runtime.logs.recent(d.app.id, 100).map((l) => l.msg).join("\n");
    assert.match(logs, /cron "\* \* \* \* \*" ok/);
    assert.match(logs, /cron "\*\/2 \* \* \* \*" ok/); // second 1s job: not timed out behind the first
    assert.match(logs, /cron "0 \* \* \* \*" failed \(500\)/);
    assert.match(logs, /late failure/);
    const db = await (await call(`/v1/apps/${d.app.name}/db`, { headers: auth })).json();
    assert.ok(db.tables.finished, "a rejected waitUntil must not cancel the others");

    // Redeploy without the crons while one is queued: the queued run is dropped at dispatch.
    const slow = srv.scheduler.tick(new Date("2026-11-19T10:02:00Z")); // * and */2 → second waits behind first
    await new Promise((r) => setTimeout(r, 200));
    await call("/v1/deploys", { method: "POST", headers: auth, body: JSON.stringify({ app: d.app.name, files: [{ path: "index.html", data: "x" }], server: "export default { fetch() { return new Response('v2') } }" }) });
    await slow;
    const after = srv.runtime.logs.recent(d.app.id, 200).map((l) => l.msg);
    assert.equal(after.filter((m) => m.startsWith('cron "*/2')).length, 1); // only the 10:00 run
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
