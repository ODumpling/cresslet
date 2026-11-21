// Load test for issue #27: how much do apps hammering their db/file bindings slow the control plane?
//
//   node scripts/loadtest-bindings.ts [--apps 4] [--concurrency 8] [--seconds 10] [--rows 200000]
//                                     [--scenarios idle,noop,db,files,scan,mixed] [--json out.json]
//
// Starts a real server (`node server/main.ts`, temp data dir) with a preload that reports its main
// thread's event-loop delay, deploys `--apps` anonymous apps, then for each scenario runs closed-loop
// app traffic from a separate process while this process probes the control plane open-loop (a
// request every 10 ms on a fixed schedule, latency counted from the scheduled time, so a stalled
// server can't hide its stall by delaying the probes). Probes: GET /healthz (just the event loop)
// and GET /v1/apps/:name (the API, with its store reads). Scenarios:
//   idle   no app traffic (baseline)
//   noop   every app answers without touching bindings (cost of proxying app requests)
//   db     every app does 3 small statements per request (insert, indexed read, LIMIT 20 read)
//   files  every app puts and reads back a 64 KiB file per request
//   scan   one app runs an unindexed aggregate over `--rows` rows; the others are idle
//   mixed  one app scans, the others run `db`
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "undici";

const ROOT = join(import.meta.dirname, "..");
const DOMAIN = "loadtest.local";

const APP = `
const BODY = new Uint8Array(64 * 1024).fill(97);
export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (p === "/api/noop") return new Response("ok");
    if (p === "/api/setup") {
      const rows = Number(new URL(req.url).searchParams.get("rows"));
      await env.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
      await env.db.exec("CREATE TABLE IF NOT EXISTS big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
      if (!(await env.db.first("SELECT 1 x FROM big LIMIT 1"))) {
        await env.db.run("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) " +
          "INSERT INTO big (v) SELECT hex(randomblob(50)) FROM c", rows);
      }
      return new Response("ok");
    }
    if (p === "/api/db") {
      const r = await env.db.run("INSERT INTO items (v) VALUES (?)", "x".repeat(100));
      await env.db.first("SELECT * FROM items WHERE id = ?", r.lastInsertRowid);
      await env.db.query("SELECT id, v FROM items ORDER BY id DESC LIMIT 20");
      return new Response("ok");
    }
    if (p === "/api/files") {
      const key = "k" + Math.floor(Math.random() * 32);
      await env.files.put(key, BODY, { contentType: "application/octet-stream" });
      await (await env.files.get(key)).arrayBuffer();
      return new Response("ok");
    }
    if (p === "/api/scan") {
      return Response.json(await env.db.first("SELECT count(*) n, sum(length(v)) s FROM big WHERE v LIKE '%ABC%'"));
    }
    return new Response("not found", { status: 404 });
  },
};`;

type Route = "noop" | "db" | "files" | "scan";
/** Route per app index (null = no traffic). */
const SCENARIOS: Record<string, (i: number) => Route | null> = {
  idle: () => null,
  noop: () => "noop",
  db: () => "db",
  files: () => "files",
  scan: (i) => (i === 0 ? "scan" : null),
  mixed: (i) => (i === 0 ? "scan" : "db"),
};

interface LoadJob { port: number; seconds: number; concurrency: number; targets: { host: string; route: Route }[] }
/** `requests`: successful responses (errors counted apart). */
interface LoadResult { route: Route; requests: number; errors: number; p50: number; p99: number }

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const ms = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "-");

// ---- load generator (child process, so its CPU doesn't skew the probes' timing)
async function runLoad(job: LoadJob): Promise<LoadResult[]> {
  const end = performance.now() + job.seconds * 1000;
  return Promise.all(job.targets.map(async ({ host, route }) => {
    const pool = new Pool(`http://127.0.0.1:${job.port}`, { connections: job.concurrency });
    const lat: number[] = [];
    let errors = 0;
    await Promise.all(Array.from({ length: job.concurrency }, async () => {
      while (performance.now() < end) {
        const t = performance.now();
        try {
          const r = await pool.request({ path: `/api/${route}`, method: "GET", headers: { host } });
          await r.body.text();
          if (r.statusCode !== 200) errors++;
          else lat.push(performance.now() - t);
        } catch {
          errors++;
        }
      }
    }));
    await pool.close();
    return { route, requests: lat.length, errors, p50: pct(lat, 50), p99: pct(lat, 99) };
  }));
}

if (process.argv[2] === "--role=load") {
  const results = await runLoad(JSON.parse(process.argv[3]) as LoadJob);
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
}

// ---- orchestrator
const { values: opt } = parseArgs({
  options: {
    apps: { type: "string", default: "4" },
    concurrency: { type: "string", default: "8" },
    seconds: { type: "string", default: "10" },
    rows: { type: "string", default: "200000" },
    scenarios: { type: "string", default: Object.keys(SCENARIOS).join(",") },
    json: { type: "string" },
  },
});
const nApps = Number(opt.apps), concurrency = Number(opt.concurrency), seconds = Number(opt.seconds);
const scenarios = opt.scenarios.split(",").map((s) => s.trim()).filter(Boolean);
for (const s of scenarios) if (!SCENARIOS[s]) throw new Error(`unknown scenario: ${s}`);

const freePort = () => new Promise<number>((res) => {
  const s = netServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => res(port));
  });
});

const agent = new Agent({ keepAlive: true, maxSockets: 256 });
function call(port: number, path: string, { host = DOMAIN, method = "GET", body, headers = {} }: {
  host?: string; method?: string; body?: string; headers?: Record<string, string>;
} = {}) {
  return new Promise<{ status: number; text: string }>((res, rej) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method, agent, headers: { host, ...headers } }, (resp) => {
      let text = "";
      resp.setEncoding("utf8").on("data", (c) => (text += c)).on("end", () => res({ status: resp.statusCode!, text }));
    });
    r.on("error", rej);
    r.end(body);
  });
}

function readEld(srv: ChildProcess) {
  return new Promise<{ p50: number; p99: number; max: number; elu: number; cores: number }>((res) => {
    srv.once("message", (m) => res((m as { eld: never }).eld));
    srv.send("eld:read");
  });
}

/** Open-loop probes until `until` resolves: one request every 10 ms, alternating the two targets. */
async function probe(port: number, appName: string, key: string, until: Promise<unknown>) {
  const out = { healthz: [] as number[], api: [] as number[], errors: [] as string[] };
  const pending: Promise<void>[] = [];
  let done = false;
  const stop = () => void (done = true);
  until.then(stop, stop); // a failed load ends the probing too (the caller sees its error)
  const start = performance.now();
  for (let i = 0; !done; i++) {
    const at = start + i * 10;
    const wait = at - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const kind = i % 2 ? "api" : "healthz";
    pending.push((async () => {
      try {
        const r = kind === "api"
          ? await call(port, `/v1/apps/${appName}`, { headers: { "x-cresslet-deploy-key": key } })
          : await call(port, "/healthz");
        if (r.status !== 200) throw new Error(`${r.status} ${r.text.slice(0, 200)}`);
        out[kind].push(performance.now() - at);
      } catch (e) {
        out.errors.push(`${kind}: ${(e as Error).message}`);
      }
    })());
  }
  await Promise.all(pending);
  return out;
}

const dataDir = mkdtempSync(join(tmpdir(), "cresslet-load-"));
const sockDir = mkdtempSync("/tmp/cll-"); // short: unix socket paths are capped at ~104 bytes
const port = await freePort();
const srv = spawn(process.execPath, ["--import", join(ROOT, "scripts/loadtest-eld.ts"), join(ROOT, "server/main.ts")], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  env: {
    ...process.env,
    PORT: String(port),
    CRESSLET_DATA_DIR: dataDir,
    CRESSLET_SOCK_DIR: sockDir,
    CRESSLET_DOMAIN: DOMAIN,
    CRESSLET_ANON_APPS_PER_HOUR: "10000",
    CRESSLET_MAX_ANON_APPS_PER_IP: "10000", // every app comes from loopback
    CRESSLET_DEPLOYS_PER_HOUR: "10000",
    CRESSLET_IDLE_MS: String(3600_000),
  },
});
const srvExited = new Promise((r) => srv.once("exit", r));
/** Graceful stop (it stops its sandboxes), killed if it takes over 10 s. */
const cleanup = async () => {
  srv.kill("SIGTERM");
  const t = setTimeout(() => (console.error("server didn't stop on SIGTERM: killing it"), srv.kill("SIGKILL")), 10_000);
  await srvExited;
  clearTimeout(t);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sockDir, { recursive: true, force: true });
};
process.once("SIGINT", () => process.exit(130));
process.once("exit", () => srv.exitCode === null && srv.signalCode === null && srv.kill("SIGKILL"));

try {
  for (let i = 0; ; i++) {
    if ((await call(port, "/healthz").catch(() => null))?.status === 200) break;
    if (i > 200) throw new Error("server didn't start");
    await new Promise((r) => setTimeout(r, 50));
  }
  const apps: { name: string; host: string; key: string }[] = [];
  for (let i = 0; i < nApps; i++) {
    const r = await call(port, "/v1/deploys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ path: "index.html", data: "hi" }], server: APP }),
    });
    if (r.status !== 201) throw new Error(`deploy: ${r.status} ${r.text}`);
    const { app, deployKey } = JSON.parse(r.text);
    const host = `${app.name}.${DOMAIN}`;
    const s = await call(port, `/api/setup?rows=${Number(opt.rows)}`, { host });
    if (s.status !== 200) throw new Error(`setup: ${s.status} ${s.text}`);
    apps.push({ name: app.name, host, key: deployKey });
  }
  // Warm every route once (sandboxes are up after setup; this primes statement paths and files).
  for (const a of apps) for (const r of ["noop", "db", "files"]) await call(port, `/api/${r}`, { host: a.host });
  const scanOnce = performance.now();
  await call(port, "/api/scan", { host: apps[0].host });
  console.error(`one scan of ${opt.rows} rows: ${ms(performance.now() - scanOnce)} ms (request round trip)`);
  // Discarded: the first seconds of probing (JIT, lazy init) aren't what the idle baseline measures.
  await probe(port, apps[apps.length - 1].name, apps[apps.length - 1].key, new Promise((r) => setTimeout(r, 2000)));

  const rows: Record<string, unknown>[] = [];
  for (const name of scenarios) {
    const targets = apps.flatMap((a, i) => {
      const route = SCENARIOS[name](i);
      return route ? [{ host: a.host, route }] : [];
    });
    const job: LoadJob = { port, seconds, concurrency, targets };
    srv.send("eld:reset");
    let load: Promise<LoadResult[]>;
    if (targets.length) {
      const child = spawn(process.execPath, [import.meta.filename, "--role=load", JSON.stringify(job)], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      child.stdout!.setEncoding("utf8").on("data", (c) => (out += c));
      load = new Promise((res, rej) =>
        child.once("exit", (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`load generator exited ${code}`)))));
    } else {
      load = new Promise((r) => setTimeout(() => r([]), seconds * 1000));
    }
    // The probe runs for the load's whole duration and stops once it's done.
    const p = await probe(port, apps[apps.length - 1].name, apps[apps.length - 1].key, load);
    const results = await load;
    const eld = await readEld(srv);
    if (p.errors.length) console.error(`${name}: ${p.errors.length} failed probes, e.g. ${p.errors[0]}`);
    const byRoute = new Map<Route, { requests: number; errors: number; p99: number }>();
    for (const r of results) {
      const t = byRoute.get(r.route) ?? { requests: 0, errors: 0, p99: 0 };
      byRoute.set(r.route, { requests: t.requests + r.requests, errors: t.errors + r.errors, p99: Math.max(t.p99, r.p99) });
    }
    rows.push({
      scenario: name,
      appRps: [...byRoute].map(([r, t]) => `${r} ${Math.round(t.requests / seconds)}/s`).join(", ") || "-",
      appErrors: results.reduce((n, r) => n + r.errors, 0),
      probeErrors: p.errors.length,
      appP99: [...byRoute].map(([r, t]) => `${r} ${ms(t.p99)}`).join(", ") || "-",
      healthzP50: p.healthz.length ? pct(p.healthz, 50) : NaN,
      healthzP99: pct(p.healthz, 99),
      healthzMax: pct(p.healthz, 100),
      apiP50: pct(p.api, 50),
      apiP99: pct(p.api, 99),
      apiMax: pct(p.api, 100),
      eldP99: eld.p99,
      eldMax: eld.max,
      mainBusy: eld.elu,
      cores: eld.cores,
    });
    console.error(`${name}: done`);
  }

  const cols: [string, (r: Record<string, unknown>) => string][] = [
    ["scenario", (r) => String(r.scenario)],
    ["app req/s", (r) => String(r.appRps)],
    ["app p99 ms", (r) => String(r.appP99)],
    ["app errors", (r) => String(r.appErrors)],
    ["probe errors", (r) => String(r.probeErrors)],
    ["/healthz p50", (r) => ms(r.healthzP50 as number)],
    ["/healthz p99", (r) => ms(r.healthzP99 as number)],
    ["/healthz max", (r) => ms(r.healthzMax as number)],
    ["/v1/apps p50", (r) => ms(r.apiP50 as number)],
    ["/v1/apps p99", (r) => ms(r.apiP99 as number)],
    ["/v1/apps max", (r) => ms(r.apiMax as number)],
    ["loop delay p99", (r) => ms(r.eldP99 as number)],
    ["loop delay max", (r) => ms(r.eldMax as number)],
    ["main busy", (r) => `${Math.round((r.mainBusy as number) * 100)}%`],
    ["cpu cores", (r) => (r.cores as number).toFixed(2)],
  ];
  console.log(`\n${nApps} apps × ${concurrency} concurrent requests, ${seconds} s per scenario, ${opt.rows} scan rows (latencies in ms)\n`);
  console.log(`| ${cols.map((c) => c[0]).join(" | ")} |`);
  console.log(`|${cols.map(() => "---").join("|")}|`);
  for (const r of rows) console.log(`| ${cols.map((c) => c[1](r)).join(" | ")} |`);
  if (opt.json) writeFileSync(opt.json, JSON.stringify({ apps: nApps, concurrency, seconds, rows: Number(opt.rows), results: rows }, null, 2));
} finally {
  agent.destroy();
  await cleanup();
}
