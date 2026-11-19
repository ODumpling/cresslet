// OS-level limits around each workerd sandbox (Linux, opt-in), on top of workerd's own isolation:
//   CRESSLET_SANDBOX_UID_BASE  run each sandbox as its own uid/gid (base + a never-reused per-app
//                              sequence). Needs the control plane to run as root.
//   CRESSLET_CGROUP_DIR        run each sandbox in its own cgroup v2 child with cpu/memory/pids caps.
// Without them sandboxes run as the control-plane user with only workerd's limits (V8 heap, timeout).
//
// With a per-app uid, nothing the sandbox can write is ever followed by root: its run dir and files
// are root-owned (group = app gid, read-only), the sockets are root-owned 0660, and workerd's listener
// is created by the control plane and passed as an fd (runtime.ts), so there's nothing to squat.
import {
  linkSync,
  readlinkSync,
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";

const CONTROLLERS = ["cpu", "memory", "pids"];
const MAX_UID = 4294967294;
/** Run dirs (and cgroups) are `<instance>-<appId>-<6 hex>`; `instance` is persisted in the data dir. */
export const RUN_DIR_RE = /^([A-Za-z0-9_-]{8})-app_[0-9a-f]+-[0-9a-f]{6}$/;
/** Longest run-dir name + "/a.sock": keeps unix socket paths under the ~104-byte limit (macOS). */
const RUN_SUFFIX = 1 + 8 + 1 + 24 + 1 + 6 + "/a.sock".length;

/** This data dir's id, so instances sharing a socket/cgroup dir never sweep each other's resources. */
export function instanceId(dataDir: string): string {
  // Two instances started from *copies* of one data dir share an id: don't point those at one socket
  // or cgroup dir. 48 random bits, base64url (8 chars, short socket paths).
  const f = join(dataDir, "instance");
  const read = () => {
    try {
      const id = readFileSync(f, "utf8").trim();
      return /^[A-Za-z0-9_-]{8}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true });
  // Publish exactly one winner: write a unique temp file, then link() it into place (fails if another
  // first start got there), and everyone returns what's persisted.
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, randomBytes(6).toString("base64url") + "\n");
  try {
    linkSync(tmp, f); // needs hard links on the data dir's filesystem
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
  const id = read();
  if (!id) throw new Error(`${f} is corrupt (expected an 8-character id); remove it`);
  return id;
}

/** Pending cgroup removals (kills on old kernels are retried on timers); shutdown waits for them. */
const removals = new Set<Promise<void>>();
export function settled(timeoutMs = 2500): Promise<void> {
  // Not unref'd: this timer keeps the process alive (and the unref'd retry timers firing) until done.
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.all(removals).then(() => {}),
    new Promise<void>((r) => (t = setTimeout(r, timeoutMs))),
  ]).finally(() => clearTimeout(t));
}

/** Startup checks + one-time host setup, before the socket dir is used. Throws on misconfiguration. */
export function prepareHost(cfg: Config) {
  const { uidBase, cgroupDir } = cfg.sandbox;
  // Every mode puts unix sockets under it; their paths are capped at ~104 bytes (macOS).
  if (Buffer.byteLength(resolve(cfg.sockDir)) + RUN_SUFFIX > 100) {
    throw new Error(`CRESSLET_SOCK_DIR is too long for unix socket paths (max ${100 - RUN_SUFFIX} bytes): ${cfg.sockDir}`);
  }
  if (uidBase !== null) {
    if (process.platform !== "linux" || process.getuid?.() !== 0) {
      throw new Error("CRESSLET_SANDBOX_UID_BASE needs Linux and the control plane running as root");
    }
    if (!Number.isInteger(uidBase) || uidBase < 1000 || uidBase > MAX_UID - 1_000_000) {
      throw new Error(`CRESSLET_SANDBOX_UID_BASE must be an integer in 1000..${MAX_UID - 1_000_000} (a uid range reserved for sandboxes)`);
    }
    // Predictable path (default /tmp/cresslet-sock): it must be ours, not something a local user made,
    // and no ancestor may let another user swap it (writable by others only with the sticky bit, like /tmp).
    // Resolve it once (symlinked parents like /var/run → /run are fine; the final component isn't) and
    // use only the resolved path from here on.
    const abs = resolve(cfg.sockDir);
    const parentReal = trustedPath(dirname(abs));
    cfg.sockDir = join(parentReal, basename(abs));
    if (Buffer.byteLength(cfg.sockDir) + RUN_SUFFIX > 100) {
      throw new Error(`CRESSLET_SOCK_DIR resolves to a path too long for unix sockets: ${cfg.sockDir}`);
    }

    if (!existsSync(cfg.sockDir)) mkdirSync(cfg.sockDir, { mode: 0o711 });
    const st = lstatSync(cfg.sockDir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0) {
      throw new Error(`${cfg.sockDir} must be a directory owned by root (CRESSLET_SOCK_DIR)`);
    }
    chmodSync(cfg.sockDir, 0o711);
    mkdirSync(cfg.dataDir, { recursive: true });
    chmodSync(cfg.dataDir, 0o700);
  }
  if (cgroupDir) {
    if (!existsSync(cgroupDir)) mkdirSync(cgroupDir);
    const parent = resolve(cgroupDir, "..");
    const need = CONTROLLERS.filter((c) => !readFileSync(join(parent, "cgroup.subtree_control"), "utf8").split(/\s+/).includes(c));
    if (need.length) {
      // cgroup v2 "no internal processes": if the server lives in the parent (typical as PID 1 of a
      // container with its own cgroup namespace), move only itself into a leaf, then delegate.
      const self = readFileSync("/proc/self/cgroup", "utf8").trim().split("::").pop()!;
      if (resolve("/sys/fs/cgroup", "." + self) === parent) {
        const leaf = join(parent, "control-plane");
        if (!existsSync(leaf)) mkdirSync(leaf);
        writeFileSync(join(leaf, "cgroup.procs"), String(process.pid));
      }
      try {
        writeFileSync(join(parent, "cgroup.subtree_control"), need.map((c) => "+" + c).join(" "));
      } catch (e) {
        throw new Error(
          `can't delegate ${need.join(" ")} to ${cgroupDir}: ${(e as Error).message}. Other processes share ` +
            `the parent cgroup; run the server alone in it (e.g. as the container's PID 1).`,
        );
      }
    }
    writeFileSync(join(cgroupDir, "cgroup.subtree_control"), CONTROLLERS.map((c) => "+" + c).join(" "));
  }
}

/** A directory component root traverses: root-owned; not writable by others unless sticky (/tmp). */
function trusted(d: string) {
  const a = lstatSync(d);
  if (a.uid !== 0 || (!a.isSymbolicLink() && (a.mode & 0o022) && !(a.mode & 0o1000))) {
    throw new Error(`${d} (on the CRESSLET_SOCK_DIR path) must be root-owned and not writable by others`);
  }
}

/**
 * Resolves `dir` like the kernel would, one component and one symlink hop at a time, checking each
 * (no realpath: it would collapse intermediate links before they're checked). A missing component is
 * created (root, 0755) only after everything leading to it passed. Returns the resolved path, which is
 * all that's used afterwards.
 */
function trustedPath(dir: string): string {
  // Component queue, like the kernel for symlink targets: their `..` applies to the directory resolved
  // so far, and their components are spliced in front of what's left (no lexical normalization). `..` in
  // the configured string itself is collapsed by resolve() first; only the resolved result is used.
  const queue = resolve(dir).split("/").filter(Boolean);
  let real = "/";
  let hops = 0;
  trusted(real);
  while (queue.length) {
    const part = queue.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      real = dirname(real);
      continue;
    }
    const next = join(real, part);
    let st;
    try {
      st = lstatSync(next);
    } catch {
      try {
        mkdirSync(next, { mode: 0o755 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // a racing start made it: re-check below
      }
      st = lstatSync(next);
    }
    trusted(next);
    if (!st.isSymbolicLink() && !st.isDirectory()) throw new Error(`${next} (on the CRESSLET_SOCK_DIR path) is not a directory`);
    if (st.isSymbolicLink()) {
      if (++hops > 40) throw new Error(`too many symlinks resolving ${dir}`);
      const target = readlinkSync(next);
      if (isAbsolute(target)) real = "/";
      queue.unshift(...target.split("/").filter(Boolean));
    } else real = next;
  }
  return real;
}

/**
 * Removes run dirs and cgroups a previous crash of *this* instance left behind: only for apps in our
 * data dir (another instance may share the socket dir).
 */
export function sweep(cfg: Config, instance: string) {
  const ours = (name: string) => RUN_DIR_RE.exec(name)?.[1] === instance;
  for (const d of existsSync(cfg.sockDir) ? readdirSync(cfg.sockDir) : []) {
    if (ours(d)) rmSync(join(cfg.sockDir, d), { recursive: true, force: true });
  }
  const dir = cfg.sandbox.cgroupDir;
  for (const d of dir && existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
    if (d.isDirectory() && ours(d.name)) void killCgroup(join(dir!, d.name));
  }
}

export interface Jail {
  uid?: number;
  /** How to start workerd: inside the cgroup from its first instruction, as the app uid. */
  command(workerd: string, args: string[]): { file: string; args: string[] };
  oomKilled(): boolean;
  /** Kills everything left in the cgroup (forked descendants too) and removes it. */
  release(): void;
}

/**
 * `name` is unique per spawn (the run dir name), so a dying predecessor never shares (or removes)
 * our cgroup. `seq()` is only called when per-app uids are on.
 */
export function jail(cfg: Config, name: string, seq: () => number, runDir: string): Jail {
  let uid: number | undefined;
  if (cfg.sandbox.uidBase !== null) {
    uid = cfg.sandbox.uidBase + seq();
    if (!Number.isInteger(uid) || uid < 1000 || uid > MAX_UID) throw new Error(`sandbox uid out of range: ${uid}`);
    lockRunDir(runDir, uid);
  }
  const dir = cfg.sandbox.cgroupDir;
  let cg: string | undefined;
  if (dir) {
    cg = join(dir, name);
    mkdirSync(cg);
    try {
      const period = 100_000;
      writeFileSync(join(cg, "cpu.max"), `${Math.round((period * cfg.sandbox.cpuPercent) / 100)} ${period}`);
      // V8 heap cap + workerd's native overhead.
      writeFileSync(join(cg, "memory.max"), String((cfg.limits.memoryMb + 128) * 1024 * 1024));
      if (existsSync(join(cg, "memory.swap.max"))) writeFileSync(join(cg, "memory.swap.max"), "0");
      writeFileSync(join(cg, "pids.max"), String(cfg.sandbox.pidsMax));
    } catch (e) {
      void killCgroup(cg);
      throw e;
    }
  }
  const oomBase = cg ? oomCount(cg) : 0;
  return {
    uid,
    command(workerd, args) {
      const drop = uid !== undefined
        ? ["setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--"]
        : [];
      if (!cg && !drop.length) return { file: workerd, args };
      // Join the cgroup first, then drop privileges and exec: no window where workerd (or app code)
      // runs outside its limits.
      const enter = cg ? `echo $$ > "$1" || exit 97; ` : "";
      return {
        file: "/bin/sh",
        args: ["-c", `${enter}shift; exec "$@"`, "sh", cg ? join(cg, "cgroup.procs") : "-", ...drop, workerd, ...args],
      };
    },
    oomKilled: () => !!cg && oomCount(cg) > oomBase,
    release() {
      if (cg) void killCgroup(cg);
    },
  };
}

/** Root owns everything; the app's group may read (and connect to the 0660 sockets), never write. */
function lockRunDir(dir: string, gid: number) {
  chownSync(dir, 0, gid);
  chmodSync(dir, 0o750);
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    chownSync(p, 0, gid);
    chmodSync(p, f.isSocket() ? 0o660 : 0o640);
  }
}

/** SIGKILL everything in the cgroup, then remove it once empty (the kill is asynchronous). */
function killCgroup(cg: string): Promise<void> {
  const kill = () => {
    try {
      writeFileSync(join(cg, "cgroup.kill"), "1"); // Linux ≥ 5.14
    } catch {
      // Older kernels: kill each member; repeated on every retry to catch processes forked meanwhile.
      try {
        for (const pid of readFileSync(join(cg, "cgroup.procs"), "utf8").split("\n").filter(Boolean)) {
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch { /* gone */ }
        }
      } catch { /* cgroup gone */ }
    }
  };
  kill();
  let done!: () => void;
  const p = new Promise<void>((r) => (done = r));
  removals.add(p);
  void p.then(() => removals.delete(p));
  const tryRemove = (left: number) => {
    try {
      rmdirSync(cg);
      done();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EBUSY" || left <= 0) return done();
      kill();
      setTimeout(() => tryRemove(left - 1), 50).unref?.();
    }
  };
  tryRemove(40);
  return p;
}

function oomCount(cg: string): number {
  try {
    return Number(readFileSync(join(cg, "memory.events"), "utf8").match(/oom_kill (\d+)/)?.[1] ?? 0);
  } catch {
    return 0;
  }
}
