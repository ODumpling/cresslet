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
  // ps lists "<id> <coolify.proxy label>" lines from $FIX/ps. $FIX/inspect-<id> sets label, name,
  // restarts, oom (sh), rendered into the -f format; $FIX/stats-<id> is "<name> <mem %>".
  docker: `#!/bin/sh
F=$FIX
for last; do :; done
case $1 in
  ps) [ -f "$F/ps" ] || exit 0; case "$*" in *"{{.ID}} {{.Label"*) cat "$F/ps" ;; *"{{.Label"*) cut -d' ' -f2 "$F/ps" ;; *) cut -d' ' -f1 "$F/ps" ;; esac ;;
  inspect) [ -f "$F/inspect-$last" ] || { echo "Error: No such object: $last" >&2; exit 1; }; [ "$2" = -f ] || exit 0; . "$F/inspect-$last"
    printf '%s\\n' "$3" | sed -e "s#{{or (index .Config.Labels \\"coolify.proxy\\") \\"-\\"}}#$label#" -e "s#{{.Name}}#$name#" \\
      -e "s#{{.RestartCount}}#$restarts#" -e "s#{{.State.OOMKilled}}#$oom#" ;;
  stats) cat "$F/stats-$last" 2>/dev/null || exit 1 ;;
  stop) [ ! -f "$F/stop-fails" ] || exit 1; echo "$2" >> "$F/stopped"; grep -v "^$2 " "$F/ps" > "$F/ps.n" || :; mv "$F/ps.n" "$F/ps" ;;
  network) echo 0123456789abcdef0123 ;;
esac`,
  // failed-<unit>: failed; active-<unit>: a run in progress; else inactive (the last run worked).
  systemctl: `#!/bin/sh
case $1 in
  is-failed) [ -f "$FIX/failed-$3" ] ;;
  is-active) if [ -f "$FIX/failed-$2" ]; then echo failed; exit 3; elif [ -f "$FIX/active-$2" ]; then echo activating; exit 3; fi; echo inactive; exit 3 ;;
esac`,
  df: `#!/bin/sh
[ ! -f "$FIX/df-fails" ] || exit 1
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
printf '/dev/sda1 100 0 100 %s%% %s\\n' "$(cat "$FIX/df")" "$(cat "$FIX/mount" 2>/dev/null || echo /)"`,
  logger: `#!/bin/sh
echo "$@" >> "$FIX/log"`,
  // $FIX/ipt-fails: every call fails. Otherwise -D (unhook's loop) finds nothing, the rest works.
  iptables: `#!/bin/sh\n[ ! -f "$FIX/ipt-fails" ] || exit 1\ncase "$*" in *" -D "*) exit 1 ;; esac`,
  ip6tables: `#!/bin/sh\n[ ! -f "$FIX/ipt-fails" ] || exit 1\ncase "$*" in *" -D "*) exit 1 ;; esac`,
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
  const container = (id: string, name: string, { restarts = 0, oom = false, proxy = false, mem = "2.50%" } = {}) => {
    set(`inspect-${id}`, `label=${proxy ? "true" : "-"} name=/${name} restarts=${restarts} oom=${oom}\n`);
    set(`stats-${id}`, `${name} ${mem}\n`);
  };
  set("ps", "c1 \nproxy true\n");
  container("c1", "cresslet-abc");
  container("proxy", "coolify-proxy", { proxy: true, mem: "99.00%" });
  const check = async (extra: Record<string, string> = {}) => {
    const before = hits.length;
    const r = await run(ALERTS, [NET], extra);
    return { ...r, sent: hits.slice(before).map((h) => h.body) };
  };
  const done = () => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, fix, hits, set, container, meminfo, run, check, done, fail: (unit: string, on = true) => (on ? set(`failed-${unit}`, "") : rmSync(join(fix, `failed-${unit}`), { force: true })), setStatus: (s: number) => (code = s) };
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
    t.set("df", "77"); // under 80 but not under 75: still firing (no flapping at the threshold)
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
    t.container("c1", "cresslet-abc", { mem: "93.10%" });
    const a = await t.check();
    assert.equal(a.sent.length, 1);
    assert.match(a.sent[0], /: host memory 95% in use; cresslet-abc at 93% of its memory limit$/);
    t.meminfo(30);
    t.container("c1", "cresslet-abc", { mem: "10.00%" });
    assert.match((await t.check()).sent[0], /recovered: host memory 95%/);

    t.container("c1", "cresslet-abc", { restarts: 1, oom: true });
    assert.deepEqual((await t.check()).sent.map((s) => s.replace(/^[^:]+: /, "")),
      ["cresslet-abc restarted (restarts: 1, last exit OOM-killed: true; docker logs cresslet-abc)"]);
    assert.deepEqual((await t.check()).sent, []);
    t.container("c1", "cresslet-abc", { restarts: 3 });
    assert.match((await t.check()).sent[0], /restarts: 3, last exit OOM-killed: false/);
    // Its state goes once Docker says the container is gone (a redeploy), and not before.
    const state = join(t.dir, "state", "restarts-c1");
    assert.ok(existsSync(state));
    t.set("ps", "c2 \nproxy true\n");
    t.container("c2", "cresslet-def");
    await t.check();
    assert.ok(existsSync(state));
    rmSync(join(t.fix, "inspect-c1"));
    await t.check();
    assert.ok(!existsSync(state));
  } finally {
    t.done();
  }
});

test("a container gone between docker ps and inspect, or a path df can't read, skips only that probe", { skip }, async () => {
  const t = await setup();
  try {
    t.set("ps", "gone \nc1 \nproxy true\n"); // no inspect-gone: replaced by a redeploy
    t.set("df-fails", "");
    t.container("c1", "cresslet-abc", { mem: "95.00%" });
    t.fail("cresslet-backup.service");
    const a = await t.check();
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stderr, /df couldn't read/);
    assert.deepEqual(a.sent.map((s) => s.replace(/^[^:]+: /, "")),
      ["the last backup failed (journalctl -u cresslet-backup)", "cresslet-abc at 95% of its memory limit"]);
  } finally {
    t.done();
  }
});

test("a probe that fails isn't a recovery", { skip }, async () => {
  const t = await setup();
  try {
    t.set("df", "90");
    t.container("c1", "cresslet-abc", { mem: "95.00%" });
    assert.equal((await t.check()).sent.length, 2);
    t.set("df-fails", "");
    rmSync(join(t.fix, "stats-c1")); // docker stats fails
    assert.deepEqual((await t.check()).sent, []);
    rmSync(join(t.fix, "df-fails"));
    t.set("df", "10");
    t.container("c1", "cresslet-abc", { mem: "5.00%" });
    assert.equal((await t.check()).sent.filter((s) => s.includes("recovered: ")).length, 2);
  } finally {
    t.done();
  }
});

test("firewall: failing closed stops Cresslet (not the proxy) and alerts until Cresslet runs again", { skip }, async () => {
  const t = await setup();
  try {
    const marker = join(t.dir, "fw", `${NET}.stopped`);
    const strip = (x: string[]) => x.map((s) => s.replace(/^[^:]+: /, ""));
    // iptables fails: firewall.sh stops what runs on the network, except Coolify's proxy, and leaves its marker.
    t.set("ipt-fails", "");
    const fw = await t.run(FIREWALL, [NET]);
    assert.notEqual(fw.code, 0);
    assert.match(fw.stderr, /stopping its containers/);
    assert.equal(readFileSync(join(t.fix, "stopped"), "utf8"), "c1\n");
    const first = readFileSync(marker, "utf8");
    assert.match(first, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ stopped\n$/);
    t.fail("cresslet-firewall.service");

    assert.deepEqual(strip((await t.check()).sent), [
      `cresslet-firewall couldn't apply its rules and stopped Cresslet at ${first.split(" ")[0]}; start it again once fixed (journalctl -u cresslet-firewall)`,
      "cresslet-firewall can't apply its rules (journalctl -u cresslet-firewall)",
    ]);
    // Started by hand while the rules still fail: stopped again, the marker keeps the first time.
    await new Promise((r) => setTimeout(r, 1100));
    t.set("ps", "c1 \nproxy true\n");
    await t.run(FIREWALL, [NET]);
    assert.equal(readFileSync(marker, "utf8"), first);
    // The rules apply again, but Cresslet stays stopped: the marker stays, one recovery (the failing unit).
    rmSync(join(t.fix, "ipt-fails"));
    const ok = await t.run(FIREWALL, [NET]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(existsSync(marker));
    t.fail("cresslet-firewall.service", false);
    assert.deepEqual(strip((await t.check()).sent), ["recovered: cresslet-firewall can't apply its rules (journalctl -u cresslet-firewall)"]);
    // Started again (in Coolify): the next firewall run removes the marker, and that's the recovery.
    t.set("ps", "c2 \nproxy true\n");
    t.container("c2", "cresslet-def");
    assert.deepEqual((await t.check()).sent, []);
    await t.run(FIREWALL, [NET]);
    assert.ok(!existsSync(marker));
    assert.match((await t.check()).sent[0], /recovered: cresslet-firewall couldn't apply its rules and stopped/);
  } finally {
    t.done();
  }
});

test("firewall: a container it couldn't stop runs unfirewalled, a new alert after a stop; only the proxy: no marker", { skip }, async () => {
  const t = await setup();
  try {
    const marker = join(t.dir, "fw", `${NET}.stopped`);
    t.set("ipt-fails", "");
    t.set("ps", "proxy true\n");
    await t.run(FIREWALL, [NET]);
    assert.ok(!existsSync(marker));

    // Stopped once, started by hand, then a run that can't stop it either: that's news.
    t.set("ps", "c1 \nproxy true\n");
    await t.run(FIREWALL, [NET]);
    assert.match((await t.check()).sent[0], /stopped Cresslet at/);
    t.set("ps", "c1 \nproxy true\n");
    t.set("stop-fails", "");
    const fw = await t.run(FIREWALL, [NET]);
    assert.match(fw.stderr, /couldn't stop: c1/);
    assert.match(readFileSync(marker, "utf8"), /^\S+ couldn't stop: c1\n$/);
    const a = (await t.check()).sent;
    assert.equal(a.length, 2);
    assert.match(a[0], /recovered: .*stopped Cresslet/);
    assert.match(a[1], /cresslet-firewall couldn't apply its rules or stop c1 at \S+: they run unfirewalled/);
    // The rules apply: the marker goes even though nothing restarted.
    rmSync(join(t.fix, "ipt-fails"));
    await t.run(FIREWALL, [NET]);
    assert.ok(!existsSync(marker));
    assert.match((await t.check()).sent[0], /recovered: .*they run unfirewalled/);
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

test("delivery: JSON for Discord/Slack; alerts that couldn't be sent go at a later check, in order", { skip }, async () => {
  const t = await setup(500);
  try {
    const json = { CRESSLET_ALERT_JSON_KEY: "content" };
    t.set("mount", '/mnt/a"b\\c');
    t.set("df", "99");
    const a = await t.check(json);
    assert.equal(a.code, 1);
    assert.match(a.stderr, /couldn't send the alert/);
    assert.match(readFileSync(join(t.fix, "log"), "utf8"), /disk 99% full/); // the journal has it right away
    // Over before the webhook is back: both alerts still arrive.
    t.set("df", "40");
    assert.equal((await t.check(json)).code, 1);
    t.setStatus(204);
    const b = await t.check(json);
    assert.equal(b.code, 0, b.stderr);
    assert.deepEqual(b.sent.map((x) => JSON.parse(x).content.replace(/^[^:]+: /, "")), [
      'disk 99% full on /mnt/a"b\\c (at ' + JSON.parse(b.sent[0]).content.split("(at ")[1],
      'recovered: disk 99% full on /mnt/a"b\\c (at ' + JSON.parse(b.sent[1]).content.split("(at ")[1],
    ]);
    assert.match(JSON.parse(b.sent[0]).content, /\(at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)$/);
    assert.equal(t.hits.at(-1)!.type, "application/json");
    assert.deepEqual((await t.check(json)).sent, []);

    const c = await t.run(ALERTS, [NET, "--test"]);
    assert.equal(c.code, 0, c.stderr);
    assert.equal(t.hits.at(-1)!.type, "text/plain");
    assert.match(t.hits.at(-1)!.body, /test alert/);
  } finally {
    t.done();
  }
});
