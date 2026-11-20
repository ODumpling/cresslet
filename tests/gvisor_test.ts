// gVisor sandboxes (CRESSLET_RUNSC). Needs Linux, root, runsc and a writable cgroup2 mount, e.g.:
//   docker run --rm --privileged --cgroupns=private -v "$PWD":/src -v /src/node_modules -w /src node:24-bookworm-slim sh -c '
//     apt-get update -qq && apt-get install -qq -y curl bzip2 >/dev/null &&
//     curl -fsSL https://storage.googleapis.com/gvisor/releases/release/20261109.0/$(uname -m)/gvisor.tar.bz2 |
//       tar -xj -C /usr/local/bin runsc gvisor-bin &&
//     npm ci --omit=dev && CRESSLET_RUNSC=/usr/local/bin/runsc exec node --test --test-isolation=none tests/gvisor_test.ts'
// The rest of the suite runs under gVisor too with CRESSLET_RUNSC set (sandbox_test pins the default mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttp } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";
import { instanceId, jail, prepareHost, settled } from "../server/sandbox.ts";

const runsc = process.env.CRESSLET_RUNSC;
const usable = process.platform === "linux" && process.getuid?.() === 0 && !!runsc && existsSync("/sys/fs/cgroup/cgroup.procs");
const skip = !usable && "needs linux + root + CRESSLET_RUNSC + cgroup2";

/** Host pids whose cmdline / exe match. */
const procs = (match: (cmd: string, exe: string) => boolean) =>
  readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => {
    try {
      return match(readFileSync(`/proc/${p}/cmdline`, "utf8"), readlinkSync(`/proc/${p}/exe`));
    } catch {
      return false;
    }
  });

const SERVER = `
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/api/oom") {
      const keep = [];
      for (let i = 0; i < 64; i++) { const b = new Uint8Array(16 * 1024 * 1024); b.fill(1); keep.push(b); }
      return new Response("survived " + keep.length);
    }
    await env.db.exec("CREATE TABLE IF NOT EXISTS t (n INTEGER)");
    await env.db.run("INSERT INTO t VALUES (1)");
    const { n } = await env.db.first("SELECT count(*) AS n FROM t");
    return new Response("ok " + n);
  },
};`;

// What code that escaped workerd could do: arbitrary native code (here node) in the same jail.
const PROBE = `
import fs from "node:fs"; import net from "node:net"; import os from "node:os"; import http from "node:http";
const [dataDir, port, hostIp, run] = process.argv.slice(2);
const tryIt = (f) => { try { f(); return "ok"; } catch (e) { return e.code; } };
const tcp = (host) => new Promise((r) => {
  const s = net.connect({ host, port: Number(port), timeout: 3000 });
  s.on("connect", () => { s.destroy(); r("connected"); }).on("error", (e) => r(e.code)).on("timeout", () => { s.destroy(); r("timeout"); });
});
const out = {
  uid: process.getuid(),
  root: fs.readdirSync("/").sort(),
  procs: fs.readdirSync("/proc").filter((p) => /^\\d+$/.test(p)).length,
  data: tryIt(() => fs.readdirSync(dataDir)),
  hostTmp: fs.readdirSync("/tmp"),
  tmpWrite: tryIt(() => fs.writeFileSync("/tmp/gv-marker", "x")),
  shmWrite: tryIt(() => fs.writeFileSync("/dev/shm/gv-marker", "x")),
  runWrite: tryIt(() => fs.writeFileSync(run + "/x", "x")),
  etc: tryIt(() => fs.readFileSync("/etc/passwd")),
  ifaces: Object.keys(os.networkInterfaces()),
  loopback: await tcp("127.0.0.1"),
  hostIp: hostIp ? await tcp(hostIp) : "none",
  bindings: await new Promise((r) => http.get({ socketPath: run + "/h.sock", path: "/ping" }, (res) => { res.resume(); r(res.statusCode); }).on("error", (e) => r(e.code))),
};
console.log(JSON.stringify(out));
`;

test("gVisor: escaped code sees only its run dir, has no network but its sockets, private /tmp", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-gv-"));
  writeFileSync(join(dataDir, "secret"), "x");
  const cfg = loadConfig({ dataDir, domain: "t", publicPort: 80, sockDir: "/tmp/cresslet-gv-sock", sandbox: { uidBase: null, cgroupDir: null, cpuPercent: 100, pidsMax: 128, runsc } });
  prepareHost(cfg);
  const run = join(cfg.sockDir, `${instanceId(dataDir)}-app_00000000000000000000beef-000001`);
  mkdirSync(run, { mode: 0o700 });
  // A control-plane port on the host's loopback, and on its external address.
  const plane = createHttp((_q, r) => r.end("plane"));
  await new Promise<void>((r) => plane.listen(0, "0.0.0.0", r));
  const port = (plane.address() as { port: number }).port;
  const hostIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "";
  const bindings = createHttp((_q, r) => r.writeHead(204).end());
  await new Promise<void>((r) => bindings.listen(join(run, "h.sock"), r));
  writeFileSync(join(run, "probe.mjs"), PROBE);
  writeFileSync("/tmp/gv-host-file", "host");
  const j = jail(cfg, "probe", () => 0, run);
  try {
    // Sanity: from the host, the plane answers on both addresses.
    assert.equal(await (await fetch(`http://${hostIp}:${port}`)).text(), "plane");
    const cmd = j.command(process.execPath, [join(run, "probe.mjs"), dataDir, String(port), hostIp, run]);
    assert.ok(cmd.file === cfg.sandbox.runsc && cmd.file.startsWith("/"), cmd.file);
    const child = spawn(cmd.file, cmd.args, { cwd: run, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((r) => child.once("exit", r));
    assert.equal(code, 0, err);
    const r = JSON.parse(out);
    console.log(r);
    assert.equal(r.uid, 0); // root inside the Sentry, without capabilities
    // Only mount points: no host /etc, /home, /data, /usr/bin, …
    for (const d of r.root) assert.ok(["dev", "etc", "lib", "lib64", "proc", "sys", "tmp", "usr", "workerd"].includes(d), d);
    assert.equal(r.etc, "ENOENT");
    assert.equal(r.data, "ENOENT");
    assert.equal(r.procs, 1); // its own pid namespace: only itself
    // /tmp is the Sentry's own tmpfs: nothing of the host's, nothing leaks back.
    assert.ok(!r.hostTmp.includes("gv-host-file"), r.hostTmp.join(" "));
    assert.equal(r.tmpWrite, "ok");
    assert.equal(r.shmWrite, "ok");
    assert.ok(!existsSync("/tmp/gv-marker") && !existsSync("/dev/shm/gv-marker"));
    assert.equal(r.runWrite, "EROFS");
    // No host network: loopback is its own, the host's address is unreachable. Its sockets still work.
    assert.deepEqual(r.ifaces, ["lo"]);
    assert.equal(r.loopback, "ECONNREFUSED");
    assert.notEqual(r.hostIp, "connected");
    assert.equal(r.bindings, 204);
  } finally {
    j.release();
    await settled(5000);
    assert.ok(!existsSync(run + ".gv"), "runsc state removed");
    plane.close();
    bindings.close();
    await rm(run, { recursive: true, force: true });
    await rm("/tmp/gv-host-file", { force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("gVisor + per-app uid + cgroups: apps run, are capped and reaped", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-gv-"));
  const cgroupDir = "/sys/fs/cgroup/cresslet-gv-test";
  const sockDir = "/tmp/cresslet-gv-sock";
  writeFileSync(join(dataDir, "instance"), "gvgvgvgv\n");
  const srv = createServer(loadConfig({
    dataDir,
    domain: "test.local",
    publicPort: 80,
    sockDir,
    sandbox: { uidBase: 300000, cgroupDir, cpuPercent: 50, pidsMax: 256, runsc },
    limits: { memoryMb: 64, requestMs: 10_000 } as never,
  }));
  const call = (path: string, host = "test.local", init: RequestInit = {}) =>
    srv.handler(new Request(`http://${host}${path}`, { ...init, headers: { host, "content-type": "application/json", ...init.headers as Record<string, string> } }));
  try {
    const d = await (await call("/v1/deploys", "test.local", {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "index.html", data: "x" }], server: SERVER }),
    })).json();
    const host = `${d.app.name}.test.local`;
    const first = await (await call("/api/x", host)).text();
    if (first !== "ok 1") console.log(srv.runtime.logs.recent(d.app.id, 50).map((l) => l.msg).join("\n"));
    assert.equal(first, "ok 1");
    assert.equal(await (await call("/api/x", host)).text(), "ok 2"); // bindings (db) over h.sock

    // The host process is runsc; workerd itself never runs as a host process.
    const pid = srv.runtime.status(d.app.id).pid!;
    assert.match(readFileSync(`/proc/${pid}/cmdline`, "utf8"), /runsc/);
    assert.deepEqual(procs((_cmd, exe) => exe === srv.cfg.workerdPath), []);

    // Inside, workerd runs as the app's uid.
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const root = cmd[cmd.indexOf("--root") + 1];
    const ps = spawnSync(runsc!, ["--root", root, "ps", "a"], { encoding: "utf8" }).stdout; // UID PID PPID … CMD
    const uids = ps.trim().split("\n").slice(1).map((l) => Number(l.trim().split(/\s+/)[0]));
    assert.ok(uids.length && uids.every((u) => u >= 300000), ps);

    // Its listener was bound by workerd and adopted into the root-owned run dir.
    const run = root.replace(/\.gv$/, "");
    assert.ok(existsSync(join(run, "a.sock")) && existsSync(join(run, "l", "a.sock")));

    // runsc, the Sentry and the gofer all run in the app's cgroup; memory.max includes their overhead.
    const cg = join("/sys/fs/cgroup", readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("::")[1]);
    assert.ok(cg.startsWith(cgroupDir + "/gvgvgvgv-" + d.app.id + "-"), cg);
    const members = readFileSync(join(cg, "cgroup.procs"), "utf8").trim().split("\n");
    assert.ok(members.length >= 3, members.join(" "));
    assert.equal(Number(readFileSync(join(cg, "memory.max"), "utf8")), (64 + 128 + 64) * 1024 * 1024);
    console.log("memory.current (idle app):", Math.round(Number(readFileSync(join(cg, "memory.current"), "utf8")) / 1e6), "MB");

    // Blowing past the cap kills the sandbox, logged; the app recovers.
    const oom = await call("/api/oom", host);
    await oom.text();
    assert.notEqual(oom.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    const logs = srv.runtime.logs.recent(d.app.id, 100).map((l) => l.msg).join("\n");
    assert.match(logs, /out of memory/, logs);
    assert.equal(await (await call("/api/x", host)).text(), "ok 3");

    // Stop: the whole sandbox dies with its cgroup; run dir and runsc state are gone.
    const pid2 = srv.runtime.status(d.app.id).pid!;
    const c2 = readFileSync(`/proc/${pid2}/cmdline`, "utf8").split("\0");
    const root2 = c2[c2.indexOf("--root") + 1];
    const cg2 = join("/sys/fs/cgroup", readFileSync(`/proc/${pid2}/cgroup`, "utf8").trim().split("::")[1]);
    srv.runtime.stop(d.app.id);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!existsSync(cg2) && !existsSync(root2) && !existsSync(root2.replace(/\.gv$/, "")));
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("gVisor: a crashed control plane's still-running sandbox is reaped before its run dir is removed", { skip }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-gv-"));
  const sockDir = "/tmp/cresslet-gv-sock";
  writeFileSync(join(dataDir, "instance"), "gvgvgvgv\n");
  const stale = join(sockDir, "gvgvgvgv-app_dead-00beef");
  mkdirSync(join(stale + ".gv", "rootfs"), { recursive: true });
  mkdirSync(join(stale, "l"), { recursive: true });
  // It keeps writing into its l/ (a run dir removed while it's alive would race it, or fail ENOTEMPTY).
  const writer = `const fs = require("fs"); let i = 0; setInterval(() => { for (let k = 0; k < 20; k++) fs.mkdirSync("/l/d" + i++ + "/x/y", { recursive: true }); }, 1);`;
  writeFileSync(join(stale + ".gv", "config.json"), JSON.stringify({
    ociVersion: "1.0.2", root: { path: "rootfs", readonly: true },
    process: { user: { uid: 0, gid: 0 }, args: ["/node", "-e", writer], cwd: "/" },
    mounts: [{ destination: "/node", source: process.execPath, type: "bind", options: ["bind", "ro"] },
      { destination: "/l", source: join(stale, "l"), type: "bind", options: ["rbind", "rw"] },
      // /lib64: the x86_64 dynamic loader lives there.
      ...["/lib", "/lib64", "/usr/lib"].filter((d) => existsSync(d))
        .map((d) => ({ destination: d, source: d, type: "bind", options: ["rbind", "ro"] }))],
  }));
  const orphan = spawn(runsc!, ["--root", stale + ".gv", "--network=none", "--ignore-cgroups", "run", "--detach", "--bundle", stale + ".gv", "a"], { stdio: "ignore" });
  await new Promise((r) => orphan.once("exit", r));
  const state = () => spawnSync(runsc!, ["--root", stale + ".gv", "state", "a"], { encoding: "utf8" }).stdout;
  assert.match(state(), /"status": "running"/);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(readdirSync(join(stale, "l")).length > 50, "orphan is writing");

  const other = join(sockDir, "hhhhhhhh-app_dead-00beef.gv"); // another instance's: left alone
  mkdirSync(other, { recursive: true });
  // A runsc that can't confirm the sandbox is gone: its run dir and state stay for a later sweep.
  const fake = join(dataDir, "fake-runsc");
  writeFileSync(fake, '#!/bin/sh\n[ "$1" = --version ] && exit 0\nexit 1\n', { mode: 0o755 });
  createServer(loadConfig({ dataDir, domain: "t", publicPort: 80, sockDir, sandbox: { uidBase: null, cgroupDir: null, cpuPercent: 100, pidsMax: 128, runsc: fake } })).close();
  assert.ok(existsSync(join(stale, "l")) && existsSync(stale + ".gv"), "kept when the reap can't be confirmed");
  assert.match(state(), /"status": "running"/);
  const srv = createServer(loadConfig({ dataDir, domain: "t", publicPort: 80, sockDir, sandbox: { uidBase: null, cgroupDir: null, cpuPercent: 100, pidsMax: 128, runsc } }));
  try {
    assert.ok(!existsSync(stale) && !existsSync(stale + ".gv"), "leftovers swept");
    assert.ok(existsSync(other));
    assert.deepEqual(procs((cmd) => cmd.includes(stale)), []);
  } finally {
    srv.close();
    await rm(other, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
