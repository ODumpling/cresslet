// Per-app uid + cgroup v2 limits. Needs Linux, root and a writable cgroup2 mount, e.g.:
//   docker run --rm --privileged --cgroupns=private -v "$PWD":/src -w /src node:24-bookworm-slim \
//     sh -c 'npm ci --omit=dev && exec node --test --test-isolation=none tests/sandbox_test.ts'
// (one process in the container's root cgroup, so the server can delegate controllers)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { loadConfig } from "../server/config.ts";
import { instanceId } from "../server/sandbox.ts";

const writable = (p: string) => {
  try {
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const usable = process.platform === "linux" && process.getuid?.() === 0 && writable("/sys/fs/cgroup/cgroup.procs");

const SERVER = `
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/api/burn") { const t = Date.now(); while (Date.now() - t < 600) {} return new Response("burnt"); }
    if (u.pathname === "/api/oom") {
      const keep = [];
      for (let i = 0; i < 64; i++) { const b = new Uint8Array(16 * 1024 * 1024); b.fill(1); keep.push(b); }
      return new Response("survived " + keep.length);
    }
    return new Response("ok");
  },
};`;

test("per-app uid and cgroup limits", { skip: !usable && "needs linux + root + cgroup2" }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-sb-"));
  const cgroupDir = "/sys/fs/cgroup/cresslet-test";
  const sockDir = "/tmp/cresslet-sb-sock";
  // Leftovers of a crashed server are swept at start; another instance's (same socket dir) are not.
  writeFileSync(join(dataDir, "instance"), "aaaaaaaa\n");
  mkdirSync(join(sockDir, "aaaaaaaa-app_dead-00beef"), { recursive: true });
  mkdirSync(join(cgroupDir, "aaaaaaaa-app_dead-00beef"), { recursive: true });
  mkdirSync(join(sockDir, "bbbbbbbb-app_dead-00beef"), { recursive: true });
  const srv = createServer(loadConfig({
    dataDir,
    domain: "test.local",
    publicPort: 80,
    sockDir: sockDir + "/", // trailing slash: normalized once by prepareHost
    sandbox: { uidBase: 200000, cgroupDir, cpuPercent: 20, pidsMax: 128, runsc: null }, // the default (non-gVisor) mode
    limits: { memoryMb: 64, requestMs: 10_000 } as never,
  }));
  const call = (path: string, host = "test.local", init: RequestInit = {}) =>
    srv.handler(new Request(`http://${host}${path}`, { ...init, headers: { host, "content-type": "application/json", ...init.headers as Record<string, string> } }));
  try {
    const deploy = async () => {
      const d = await (await call("/v1/deploys", "test.local", {
        method: "POST",
        body: JSON.stringify({ files: [{ path: "index.html", data: "x" }], server: SERVER }),
      })).json();
      return { ...d.app, key: d.deployKey };
    };
    const a = await deploy(), b = await deploy();
    const first = await (await call("/api/x", `${a.name}.test.local`)).text();
    if (first !== "ok") console.log(srv.runtime.logs.recent(a.id, 50).map((l) => l.msg).join("\n"));
    assert.equal(await (await call("/api/x", `${a.name}.test.local`)).text(), "ok");
    assert.equal(await (await call("/api/x", `${b.name}.test.local`)).text(), "ok");

    const pidA = srv.runtime.status(a.id).pid!, pidB = srv.runtime.status(b.id).pid!;
    const uidOf = (pid: number) => Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)![1]);
    const uidA = uidOf(pidA), uidB = uidOf(pidB);
    assert.ok(uidA >= 200000 && uidB >= 200000 && uidA !== uidB, `${uidA} ${uidB}`);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!existsSync(join(sockDir, "aaaaaaaa-app_dead-00beef")) && !existsSync(join(cgroupDir, "aaaaaaaa-app_dead-00beef")));
    assert.ok(existsSync(join(sockDir, "bbbbbbbb-app_dead-00beef")));

    const cgA = join("/sys/fs/cgroup", readFileSync(`/proc/${pidA}/cgroup`, "utf8").trim().split("::")[1]);
    assert.ok(cgA.startsWith(cgroupDir + "/aaaaaaaa-" + a.id + "-"), cgA);
    assert.equal(readFileSync(join(cgA, "cpu.max"), "utf8").trim(), "20000 100000");
    assert.equal(Number(readFileSync(join(cgA, "memory.max"), "utf8")), (64 + 128) * 1024 * 1024);
    assert.equal(readFileSync(join(cgA, "pids.max"), "utf8").trim(), "128");

    // As app A's uid: no control-plane data, no other app's run dir.
    const asA = (cmd: string, ...args: string[]) => spawnSync(cmd, args, { uid: uidA, gid: uidA }).status;
    assert.notEqual(asA("cat", join(dataDir, "cresslet.db")), 0);
    assert.notEqual(asA("ls", join(dataDir, "apps")), 0);
    const cfgOf = (pid: number) => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").find((s) => s.endsWith("config.capnp"))!;
    const runA = join(cfgOf(pidA), ".."), runB = cfgOf(pidB);
    assert.notEqual(asA("cat", runB), 0);
    assert.equal(spawnSync("cat", [runB], { uid: uidB, gid: uidB }).status, 0); // sanity: B can read its own
    // Its own run dir is root-owned and read-only to it: nothing there it could swap (e.g. a socket
    // for a symlink to another app's bindings). workerd's listener is created by root and passed as fd 3.
    assert.equal(statSync(runA).uid, 0);
    assert.equal(statSync(join(runA, "a.sock")).uid, 0);
    assert.notEqual(asA("touch", join(runA, "x")), 0);
    for (const f of ["h.sock", "a.sock"]) assert.notEqual(asA("rm", "-f", join(runA, f)), 0);

    // CPU cap: a 600ms busy loop at 20% gets throttled.
    assert.equal(await (await call("/api/burn", `${a.name}.test.local`)).text(), "burnt");
    const throttled = Number(readFileSync(join(cgA, "cpu.stat"), "utf8").match(/nr_throttled (\d+)/)![1]);
    assert.ok(throttled > 0, `nr_throttled=${throttled}`);

    // Memory cap: blowing past memory.max kills the sandbox, logged; the app recovers.
    const oom = await call("/api/oom", `${a.name}.test.local`);
    await oom.text();
    assert.notEqual(oom.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    const logs = srv.runtime.logs.recent(a.id, 100).map((l) => l.msg).join("\n");
    assert.match(logs, /out of memory/);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!existsSync(cgA), "cgroup released");
    assert.equal(await (await call("/api/x", `${a.name}.test.local`)).text(), "ok");

    // Anything left in the sandbox's cgroup (e.g. a process it forked) dies with it.
    const pidA2 = srv.runtime.status(a.id).pid!;
    const cgA2 = join("/sys/fs/cgroup", readFileSync(`/proc/${pidA2}/cgroup`, "utf8").trim().split("::")[1]);
    const stray = spawn("sleep", ["60"], { uid: uidA, gid: uidA });
    writeFileSync(join(cgA2, "cgroup.procs"), String(stray.pid));
    const strayDied = new Promise((r) => stray.once("exit", r));
    srv.runtime.stop(a.id);
    await strayDied;
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!existsSync(cgA2));

    // uids are never reused, even after the newest app is deleted.
    await call(`/v1/apps/${b.name}`, "test.local", { method: "DELETE", headers: { "x-cresslet-deploy-key": b.key } });
    const c2 = await deploy();
    assert.equal(await (await call("/api/x", `${c2.name}.test.local`)).text(), "ok");
    const uidC = uidOf(srv.runtime.status(c2.id).pid!);
    assert.ok(uidC !== uidA && uidC !== uidB, `reused uid ${uidC}`);
  } finally {
    srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("per-app uids refuse an untrusted socket dir", { skip: !usable && "needs linux + root + cgroup2" }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-sb-"));
  const sockDir = "/tmp/cresslet-sb-evil";
  mkdirSync(sockDir, { recursive: true });
  spawnSync("chown", ["65534", sockDir]);
  try {
    assert.throws(
      () => createServer(loadConfig({ dataDir, domain: "t", publicPort: 80, sockDir, sandbox: { uidBase: 200000, cgroupDir: null, cpuPercent: 100, pidsMax: 128 } })),
      /must be a directory owned by root/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("instance id: persisted, 8 chars, one winner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-inst-"));
  try {
    const a = instanceId(dir), b = instanceId(dir);
    assert.match(a, /^[A-Za-z0-9_-]{8}$/);
    assert.equal(a, b);
    writeFileSync(join(dir, "instance"), "garbage\n");
    assert.throws(() => instanceId(dir), /corrupt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-app uids don't create dirs under an untrusted parent", { skip: !usable && "needs linux + root + cgroup2" }, async () => {
  const made: string[] = [];
  const tmp = async (prefix: string) => {
    const d = await mkdtemp(prefix);
    made.push(d);
    return d;
  };
  try {
    const dataDir = await tmp(join(tmpdir(), "cresslet-sb-"));
    const untrusted = await tmp("/tmp/cresslet-u-");
    spawnSync("chown", ["65534", untrusted]);
    const trustedDir = await tmp("/tmp/cresslet-t-");
    const links = await tmp("/tmp/cresslet-l-");
    // A root-owned link straight into a user-owned dir, and one that only passes *through* it
    // (`<untrusted>/../<trusted>`: the kernel traverses the untrusted dir, lexical normalization wouldn't).
    symlinkSync(untrusted, join(links, "hop"));
    symlinkSync(`${untrusted}/../${trustedDir.split("/").pop()}`, join(links, "through"));
    const opts = (sockDir: string) => loadConfig({ dataDir, domain: "t", publicPort: 80, sockDir, sandbox: { uidBase: 200000, cgroupDir: null, cpuPercent: 100, pidsMax: 128 } });
    assert.throws(() => createServer(opts(join(untrusted, "x/sock"))), /must be root-owned/);
    assert.ok(!existsSync(join(untrusted, "x")));
    assert.throws(() => createServer(opts(join(links, "hop/y/sock"))), /must be root-owned/);
    assert.ok(!existsSync(join(untrusted, "y")));
    assert.throws(() => createServer(opts(join(links, "through/sock"))), /must be root-owned/);
    assert.ok(!existsSync(join(trustedDir, "sock")));
    // A (root-owned) regular file can't be traversed, even when followed by `..` in a link target.
    writeFileSync(join(trustedDir, "file"), "");
    symlinkSync(`${trustedDir}/file/..`, join(links, "viaFile"));
    assert.throws(() => createServer(opts(join(links, "viaFile/sock"))), /not a directory/);
    assert.ok(!existsSync(join(trustedDir, "sock")));
  } finally {
    for (const d of made) await rm(d, { recursive: true, force: true });
  }
});
