// deploy/coolify/alerts.sh (and firewall.sh failing closed) against stub docker, systemctl, df and
// iptables, with a real HTTP endpoint for the webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ALERTS = resolve("deploy/coolify/alerts.sh");
const FIREWALL = resolve("deploy/coolify/firewall.sh");
const NET = "netuuid";

const STUBS: Record<string, string> = {
  // ps lists "<id> <coolify.proxy label>" lines from $FIX/ps; inspect/stats read $FIX/inspect-<id>, $FIX/stats-<id>.
  docker: `#!/bin/sh
F=$FIX
for last; do :; done
case $1 in
  ps) [ -f "$F/ps" ] || exit 0; case "$*" in *coolify.proxy*) cat "$F/ps" ;; *) cut -d' ' -f1 "$F/ps" ;; esac ;;
  inspect) [ -f "$F/inspect-$last" ] || exit 1; case "$*" in *-f*) cat "$F/inspect-$last" ;; esac ;;
  stats) cat "$F/stats-$last" 2>/dev/null || echo 0.00% ;;
  stop) echo "$2" >> "$F/stopped"; grep -v "^$2 " "$F/ps" > "$F/ps.n" || :; mv "$F/ps.n" "$F/ps" ;;
  network) echo 0123456789abcdef0123 ;;
esac`,
  systemctl: `#!/bin/sh
[ "$1" = is-failed ] && [ -f "$FIX/failed-$3" ]`,
  df: `#!/bin/sh
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/sda1 100 0 100 $(cat "$FIX/df")% /"`,
  logger: `#!/bin/sh
echo "$@" >> "$FIX/log"`,
  iptables: "#!/bin/sh\nexit 1",
  ip6tables: "#!/bin/sh\nexit 1",
};

interface Hit { type: string; body: string }

async function setup(status = 200) {
  const dir = mkdtempSync(join(tmpdir(), "cresslet-alerts-"));
  const fix = join(dir, "fix"), bin = join(dir, "bin");
  mkdirSync(fix);
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body + "\n");
    chmodSync(join(bin, name), 0o755);
  }
  const hits: Hit[] = [];
  let code = status;
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ type: req.headers["content-type"] ?? "", body });
      res.writeHead(code).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const env = (extra: Record<string, string>) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FIX: fix,
    CRESSLET_ALERT_CONF: join(dir, "none.env"),
    CRESSLET_ALERT_STATE: join(dir, "state"),
    CRESSLET_FIREWALL_STATE: join(dir, "fw"),
    CRESSLET_ALERT_MEMINFO: join(fix, "meminfo"),
    CRESSLET_ALERT_PATHS: `${fix} ${bin}`, // two paths on one (stub) filesystem: reported once
    CRESSLET_ALERT_URL: `http://127.0.0.1:${port}/hook`,
    ...extra,
  });
  const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stderr: string }>((r) =>
      execFile("sh", [script, ...args], { env: env(extra) }, (err, _out, stderr) =>
        r({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stderr })));
  const set = (name: string, value: string) => writeFileSync(join(fix, name), value);
  const meminfo = (usedPct: number) => set("meminfo", `MemTotal: 1000 kB\nMemFree: 0 kB\nMemAvailable: ${1000 - usedPct * 10} kB\n`);
  // A healthy host: one Cresslet container and Coolify's proxy on the network.
  set("df", "40");
  meminfo(30);
  set("ps", "c1 \nproxy true\n");
  set("inspect-c1", "/cresslet-abc - 0 false\n");
  set("inspect-proxy", "/coolify-proxy true 0 false\n");
  set("stats-c1", "2.50%\n");
  set("stats-proxy", "99.00%\n");
  const check = async (extra: Record<string, string> = {}) => {
    const before = hits.length;
    const r = await run(ALERTS, [NET], extra);
    return { ...r, sent: hits.slice(before).map((h) => h.body) };
  };
  const done = () => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, fix, hits, set, meminfo, run, check, done, fail: (unit: string, on = true) => (on ? set(`failed-${unit}`, "") : rmSync(join(fix, `failed-${unit}`), { force: true })), setStatus: (s: number) => (code = s) };
}

const skip = process.platform === "win32" ? "needs sh" : false;

test("disk: one alert when it crosses the threshold, none while it stays, one when it recovers", { skip }, async () => {
  const t = await setup();
  try {
    assert.deepEqual((await t.check()).sent, []);
    t.set("df", "85");
    const a = await t.check();
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.sent.length, 1);
    assert.match(a.sent[0], /^cresslet on .+: disk 85% full on \/$/); // the two paths share one filesystem
    t.set("df", "90");
    assert.deepEqual((await t.check()).sent, []);
    t.set("df", "50");
    assert.deepEqual((await t.check()).sent.map((s) => s.replace(/^cresslet on [^:]+: /, "")), ["recovered: disk 85% full on /"]);
    assert.deepEqual((await t.check()).sent, []);
    assert.match(readFileSync(join(t.fix, "log"), "utf8"), /-t cresslet-alert -- cresslet on .+: disk 85% full/);
  } finally {
    t.done();
  }
});

test("memory: host use, the Cresslet container against its limit (not the proxy), and each restart", { skip }, async () => {
  const t = await setup();
  try {
    t.meminfo(95);
    t.set("stats-c1", "93.10%\n");
    const a = await t.check();
    assert.equal(a.sent.length, 1);
    assert.match(a.sent[0], /: host memory 95% in use; cresslet-abc at 93% of its memory limit$/);
    t.meminfo(30);
    t.set("stats-c1", "10.00%\n");
    assert.match((await t.check()).sent[0], /recovered: host memory 95%/);

    t.set("inspect-c1", "/cresslet-abc - 1 true\n");
    assert.deepEqual((await t.check()).sent.map((s) => s.replace(/^[^:]+: /, "")),
      ["cresslet-abc restarted (restarts: 1, OOM-killed: true; docker logs cresslet-abc)"]);
    assert.deepEqual((await t.check()).sent, []);
    t.set("inspect-c1", "/cresslet-abc - 2 false\n");
    assert.match((await t.check()).sent[0], /restarts: 2/);
  } finally {
    t.done();
  }
});

test("firewall: failing closed stops Cresslet (not the proxy) and alerts until Cresslet runs again", { skip }, async () => {
  const t = await setup();
  try {
    // iptables fails: firewall.sh stops what runs on the network, except Coolify's proxy, and leaves its marker.
    const fw = await t.run(FIREWALL, [NET]);
    assert.notEqual(fw.code, 0);
    assert.match(fw.stderr, /stopping its containers/);
    assert.equal(readFileSync(join(t.fix, "stopped"), "utf8"), "c1\n");
    assert.ok(existsSync(join(t.dir, "fw", `${NET}.stopped`)));
    t.fail("cresslet-firewall.service");

    const a = await t.check();
    assert.equal(a.sent.length, 1);
    assert.match(a.sent[0], /cresslet-firewall couldn't apply its rules and stopped Cresslet at \d{4}-\d\d-\d\dT.*; start it again once fixed$/);
    // The rules apply again, but Cresslet stays stopped: still the same alert, not re-sent.
    t.fail("cresslet-firewall.service", false);
    assert.deepEqual((await t.check()).sent, []);
    assert.ok(existsSync(join(t.dir, "fw", `${NET}.stopped`)));
    // Started again (in Coolify): recovered, and the marker is gone.
    t.set("ps", "c2 \nproxy true\n");
    t.set("inspect-c2", "/cresslet-def - 0 false\n");
    assert.match((await t.check()).sent[0], /recovered: cresslet-firewall couldn't apply/);
    assert.ok(!existsSync(join(t.dir, "fw", `${NET}.stopped`)));

    // Failing without stopping anything (e.g. no network yet) alerts too.
    t.fail("cresslet-firewall.service");
    assert.match((await t.check()).sent[0], /cresslet-firewall can't apply its rules \(journalctl -u cresslet-firewall\)$/);
  } finally {
    t.done();
  }
});

test("a failed backup run alerts", { skip }, async () => {
  const t = await setup();
  try {
    t.fail("cresslet-backup.service");
    assert.match((await t.check()).sent[0], /the last backup failed \(journalctl -u cresslet-backup\)$/);
  } finally {
    t.done();
  }
});

test("delivery: JSON for Discord/Slack, and a failed send is retried at the next check", { skip }, async () => {
  const t = await setup(500);
  try {
    t.set("df", "99");
    const a = await t.check({ CRESSLET_ALERT_JSON_KEY: "content" });
    assert.equal(a.code, 1);
    assert.match(a.stderr, /couldn't send the alert/);
    t.setStatus(204);
    const b = await t.check({ CRESSLET_ALERT_JSON_KEY: "content" });
    assert.equal(b.code, 0, b.stderr);
    assert.equal(b.sent.length, 1);
    assert.match(JSON.parse(b.sent[0]).content, /disk 99% full on \/$/);
    assert.equal(t.hits.at(-1)!.type, "application/json");

    const c = await t.run(ALERTS, [NET, "--test"]);
    assert.equal(c.code, 0, c.stderr);
    assert.equal(t.hits.at(-1)!.type, "text/plain");
    assert.match(t.hits.at(-1)!.body, /test alert/);
  } finally {
    t.done();
  }
});
