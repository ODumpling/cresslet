import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { type Config, paths, previewAppName } from "./config.ts";
import { type App, type Deploy, id, type Store } from "./store.ts";
import { normalizeCrons } from "./cron.ts";
import { filesSettled } from "./bindings.ts";

export interface DeployFile {
  path: string;
  data: string;
  encoding?: "base64" | "utf8";
}

export interface DeployInput {
  files: DeployFile[];
  server?: string | null;
  config?: { routes?: string[]; crons?: string[] };
  /** Client label: "cli" | "studio" | "api". */
  source?: string;
  /** Optional project source (not served), so another client can open it (GET /v1/apps/:name/source). */
  sources?: DeployFile[];
  /** The commit this was built from (source control): shown with the deploy. */
  git?: { sha?: unknown; branch?: unknown; repo?: unknown } | null;
}

/** Never stored as source (or committed to a repository): local secrets, build output, dependencies, VCS. */
export const NOT_SOURCE = /(?:^|\/)(?:node_modules|\.git|\.cresslet|\.env[^/]*)\/|^dist\/|(?:^|\/)\.env[^/]*(?:local|cresslet)[^/]*$|(?:^|\/)(?:\.envrc[^/]*|\.dev\.vars(?:[._-][^/]*)?)$/i;
// Any .env-prefixed file (sanitized: only public entries kept).
export const DOTENV = /(?:^|\/)\.env[^/]*$/i;
/** Other dotenv files keep only what the build exposes to the client anyway (docs/app-format.md). */
export function publicDotenv(data: Uint8Array): Uint8Array {
  return new TextEncoder().encode(publicDotenvText(new TextDecoder().decode(data)));
}
/**
 * Fail closed: dotenv parsers differ (multi-line quotes, escapes, values starting on the next line, `KEY: v`), so
 * only lines that every parser reads as one complete single-line entry are understood: `NAME=value`, a non-empty
 * unquoted value or a backslash-free single-line '…' / "…", optional `# comment`. Public ones (CRESSLET_PUBLIC_*,
 * VITE_*) are kept (a trailing comment cut off: it could hold anything), comments are dropped, and the first line not understood ends the file.
 */
const SAFE_ENTRY = /^([ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*=[ \t]*(?:[^\s"'\x60\\#][^"'\x60\\\r\n#]*|"[^"\\\r\n]*"|'[^'\\\r\n]*'))[ \t]*(?:#[^"'\x60\\\r\n]*)?$/;
export function publicDotenvText(text: string): string {
  const out: string[] = [];
  for (const l of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/[\r\u2028\u2029]/.test(l)) break; // a line break to some parsers, not to others
    if (/^[ \t]*$/.test(l)) out.push(l);
    else if (!/^[ \t]*#/.test(l)) {
      const m = SAFE_ENTRY.exec(l);
      if (!m) break; // anything else may open a value that runs on: drop it and the rest
      if (/^(?:CRESSLET_PUBLIC_|VITE_)/.test(m[2])) out.push(m[1].trimEnd()); // without its comment
    }
  }
  return out.join("\n");
}

export class HttpError extends Error {
  status: number;
  code: string;
  /** More fields for the error body (e.g. a conflict's paths). */
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(["www", "api", "studio", "admin", "app", "apps", "docs", "status", "mail", "preview"]);

/** Well-formed, but kept for the platform (or the studio preview host). */
export function reservedName(name: string, cfg?: Config) {
  return NAME_RE.test(name) && !name.includes("--") && !validName(name, cfg);
}

export function validName(name: string, cfg?: Config) {
  if (cfg && name === previewAppName(cfg)) return false; // the studio preview host
  return NAME_RE.test(name) && !RESERVED.has(name) && !name.includes("--");
}

export function safePath(p: string): string {
  const raw = p.replace(/\\/g, "/");
  const n = posix.normalize("/" + raw).slice(1);
  if (!n || raw.split("/").includes("..") || n.includes("\0") || n.length > 300 || n.endsWith("/")) {
    throw new HttpError(400, `invalid file path: ${p}`, "invalid_path");
  }
  return n;
}

const ADJ = ["amber", "brisk", "calm", "dapper", "eager", "fuzzy", "gentle", "hazy", "jolly", "keen",
  "lucky", "mellow", "nimble", "olive", "plucky", "quiet", "rosy", "sunny", "tidy", "vivid", "witty", "zesty"];
const NOUN = ["badger", "comet", "dune", "ember", "fjord", "grove", "harbor", "island", "lagoon",
  "meadow", "nebula", "orchid", "pebble", "quartz", "river", "summit", "tulip", "valley", "willow"];

export function randomName() {
  const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${pick(ADJ)}-${pick(NOUN)}-${hex}`;
}

export function normalizeRoutes(routes: unknown): string[] {
  if (routes === undefined) return ["/api/*"];
  if (!Array.isArray(routes) || routes.length > 50) {
    throw new HttpError(400, "config.routes must be an array of path patterns");
  }
  return routes.map((r) => {
    // `!/assets/*`: an exclusion (served statically even when another pattern matches)
    if (typeof r !== "string" || !(r.startsWith("/") || r.startsWith("!/")) || r.length > 200) {
      throw new HttpError(400, `invalid route: ${r}`);
    }
    return r;
  });
}

/**
 * Project source as stored or committed (fail closed): paths checked, files that are never source dropped, dotenv
 * files cut to their public entries. Within the deploy limits.
 */
export function sourceFiles(cfg: Config, files: DeployFile[]): [string, Uint8Array][] {
  if (!Array.isArray(files)) throw new HttpError(400, "files must be an array");
  if (files.length > cfg.limits.deployFiles) throw new HttpError(413, `too many files (max ${cfg.limits.deployFiles})`, "too_large");
  const wanted = files.filter((f) => !NOT_SOURCE.test(safePath(String(f?.path))));
  return decodeFiles(cfg, wanted, { bytes: 0, files: 0 }).decoded.map(([p, d]) => [p, DOTENV.test(p) ? publicDotenv(d) : d]);
}

/** The project source stored with a deploy (its `sources`), sorted by path; null when it was deployed without it. */
export async function deploySource(cfg: Config, appId: string, deployId: string): Promise<[string, Uint8Array][] | null> {
  const root = join(paths(cfg, appId).deploy(deployId), "source");
  if (!existsSync(root)) return null;
  const out: [string, Uint8Array][] = [];
  for (const e of (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())) {
    const abs = join(e.parentPath, e.name);
    out.push([relative(root, abs).split("\\").join("/"), await readFile(abs)]);
  }
  return out.sort(([x], [y]) => x.localeCompare(y));
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A deploy's `git` provenance, checked (null when none was sent). */
export function gitProvenance(g: DeployInput["git"]): { sha: string; branch: string | null; repo: string | null } | null {
  if (g == null) return null;
  if (typeof g !== "object" || Array.isArray(g)) throw new HttpError(400, "git must be an object: { sha, branch, repo }");
  if (typeof g.sha !== "string" || !SHA_RE.test(g.sha)) throw new HttpError(400, "git.sha must be a full commit SHA (40 hex characters)");
  if (g.branch != null && (typeof g.branch !== "string" || !g.branch || g.branch.length > 255 || /[\x00-\x20~^:?*\[\\]/.test(g.branch))) {
    throw new HttpError(400, "git.branch must be a branch name");
  }
  if (g.repo != null && (typeof g.repo !== "string" || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(g.repo))) {
    throw new HttpError(400, "git.repo must be owner/name");
  }
  return { sha: g.sha, branch: (g.branch as string | null | undefined) ?? null, repo: (g.repo as string | null | undefined) ?? null };
}

/** Decodes files against a shared budget (built files + source count together). */
function decodeFiles(cfg: Config, files: DeployFile[], budget: { bytes: number; files: number }) {
  const seen = new Set<string>();
  const decoded: [string, Uint8Array][] = [];
  let bytes = 0;
  for (const f of files) {
    if (typeof f?.path !== "string" || typeof f?.data !== "string") {
      throw new HttpError(400, "each file needs string path and data");
    }
    const p = safePath(f.path);
    if (seen.has(p)) throw new HttpError(400, `duplicate file: ${p}`);
    seen.add(p);
    const data = f.encoding === "base64" ? new Uint8Array(Buffer.from(f.data, "base64")) : new TextEncoder().encode(f.data);
    bytes += data.byteLength;
    budget.bytes += data.byteLength;
    if (++budget.files > cfg.limits.deployFiles) {
      throw new HttpError(413, `too many files (max ${cfg.limits.deployFiles})`, "too_large");
    }
    if (budget.bytes > cfg.limits.deployBytes) {
      throw new HttpError(413, `deploy exceeds ${cfg.limits.deployBytes} bytes`, "too_large");
    }
    decoded.push([p, data]);
  }
  // A path can't be both a file and a directory (e.g. `assets` and `assets/logo.svg`).
  for (const p of seen) {
    for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) {
      if (seen.has(p.slice(0, i))) throw new HttpError(400, `${p.slice(0, i)} is both a file and a directory`);
    }
  }
  return { decoded, bytes };
}

/** Write a deploy to disk and activate it. Deploys are immutable; activation swaps a pointer. */
export async function writeDeploy(cfg: Config, store: Store, app: App, input: DeployInput) {
  if (!Array.isArray(input.files)) throw new HttpError(400, "files must be an array");
  if (input.files.length > cfg.limits.deployFiles) {
    throw new HttpError(413, `too many files (max ${cfg.limits.deployFiles})`, "too_large");
  }
  const routes = normalizeRoutes(input.config?.routes);
  let crons: string[];
  try {
    crons = normalizeCrons(input.config?.crons);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (input.sources !== undefined && !Array.isArray(input.sources)) throw new HttpError(400, "sources must be an array");
  const git = gitProvenance(input.git);
  const budget = { bytes: 0, files: 0 };
  const { decoded, bytes } = decodeFiles(cfg, input.files, budget);
  // Source is optional: if it doesn't fit in what's left of the budget, deploy without it (and say so).
  let sources: ReturnType<typeof decodeFiles> = { decoded: [], bytes: 0 };
  let warning: string | undefined;
  const wanted = (input.sources ?? []).filter((f) => !NOT_SOURCE.test(safePath(String(f?.path))));
  try {
    sources = decodeFiles(cfg, wanted, budget);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 413) throw e;
    warning = `source not stored: ${e.message} (built files and source share one limit)`;
  }
  sources.decoded = sources.decoded.map(([p, d]) => [p, DOTENV.test(p) ? publicDotenv(d) : d]);
  const deployId = id("dep");
  const dir = paths(cfg, app.id).deploy(deployId);
  const pub = join(dir, "public");
  const server = input.server ?? null;
  if (server !== null && typeof server !== "string") throw new HttpError(400, "server must be a string");
  if (server && server.length > cfg.limits.serverBytes) {
    throw new HttpError(413, "server bundle too large", "too_large");
  }

  if (crons.length && !server) throw new HttpError(400, "crons need a server (server/index.ts with a scheduled() export)");
  const config = { routes, server: !!server, ...(crons.length ? { crons } : {}) };
  try {
    await mkdir(pub, { recursive: true });
    for (const [p, data] of decoded) {
      await mkdir(dirname(join(pub, p)), { recursive: true });
      await writeFile(join(pub, p), data);
    }
    if (server) await writeFile(join(dir, "server.js"), server);
    for (const [p, data] of sources.decoded) {
      await mkdir(dirname(join(dir, "source", p)), { recursive: true });
      await writeFile(join(dir, "source", p), data);
    }
    await writeFile(join(dir, "deploy.json"), JSON.stringify(config));
  } catch (e) {
    // Not recorded yet, so pruning would never find it.
    await rm(dir, { recursive: true, force: true });
    throw e;
  }

  // Row and pointer together, under the lock a prune chooses under: it never sees this deploy unserved.
  await store.serialized(deploysLock(app.id), async () => {
    await store.addDeploy({
      id: deployId,
      app_id: app.id,
      created_at: Date.now(),
      bytes: bytes + sources.bytes,
      file_count: decoded.length,
      has_server: server ? 1 : 0,
      source: String(input.source ?? "api").slice(0, 20),
      git_sha: git?.sha ?? null,
      git_branch: git?.branch ?? null,
      git_repo: git?.repo ?? null,
    });
    await store.setCurrentDeploy(app.id, deployId, config);
  });
  await pruneDeploys(cfg, store, app.id, deployId);
  return { id: deployId, bytes, files: decoded.length, server: !!server, ...(warning ? { warning } : {}) };
}

/**
 * A page's upload: static files only (no server, crons or source), with an `index.html` at the
 * root. Served from `page_deploy_id`, like an app's deploy otherwise.
 */
export async function writePage(cfg: Config, store: Store, app: App, files: DeployFile[], source = "api") {
  if (!Array.isArray(files) || !files.length) throw new HttpError(400, "files must be a non-empty array (or send html)");
  if (files.length > cfg.limits.deployFiles) throw new HttpError(413, `too many files (max ${cfg.limits.deployFiles})`, "too_large");
  const { decoded, bytes } = decodeFiles(cfg, files, { bytes: 0, files: 0 });
  if (!decoded.some(([p]) => p === "index.html")) throw new HttpError(400, "an artifact needs an index.html at its root", "no_index");
  const deployId = id("dep");
  const dir = paths(cfg, app.id).deploy(deployId);
  const pub = join(dir, "public");
  try {
    await mkdir(pub, { recursive: true });
    for (const [p, data] of decoded) {
      await mkdir(dirname(join(pub, p)), { recursive: true });
      await writeFile(join(pub, p), data);
    }
    await writeFile(join(dir, "deploy.json"), JSON.stringify({ routes: [], server: false }));
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  // Row and pointer together, under the page's lock: a prune never sees the new version unserved.
  await store.serialized(pageLock(app.id), async () => {
    await store.addDeploy({
      id: deployId,
      app_id: app.id,
      created_at: Date.now(),
      bytes,
      file_count: decoded.length,
      has_server: 0,
      source: String(source).slice(0, 20),
    });
    const previous = (await store.appById(app.id, true))?.page_deploy_id;
    await store.setPageDeploy(app.id, deployId);
    if (previous) replacedAt.set(previous, performance.now());
  });
  await prunePage(cfg, store, app.id);
  return { id: deployId, bytes, files: decoded.length };
}

/** Held while choosing an app's deploys to prune, and by a rollback while it checks and swaps (api.ts). */
export const deploysLock = (appId: string) => `cresslet:deploys:${appId}`;
const pageLock = (appId: string) => `cresslet:page:${appId}`;

/** Deploys an app keeps for rollback (the current one included). */
export const KEEP_DEPLOYS = 5;

/** Keep `keep`, the current deploy, and the most recent others: `keepCount` in all. */
async function pruneDeploys(cfg: Config, store: Store, appId: string, keep: string, keepCount = KEEP_DEPLOYS) {
  const todo = await selectForRemoval(store, deploysLock(appId), async () => {
    const current = (await store.appById(appId, true))?.current_deploy_id; // a rollback may have swapped it meanwhile
    // Ones another prune is already removing don't count as kept.
    const others = (await store.deploys(appId, 1000)).filter((d) => d.id !== keep && d.id !== current && !removing.has(d.id));
    return others.slice(keepCount - (current && current !== keep ? 2 : 1));
  });
  await removeDeploys(cfg, store, todo);
}

/** A replaced page version stays this long, so a request that read the old pointer can finish. */
const PAGE_GRACE_MS = 60_000;
/** …but no more than this many versions in all (the served one included), however fast the uploads. */
const MAX_PAGE_VERSIONS = 3;
/**
 * When each page version stopped being served (monotonic clock: wall time can step). Kept in memory:
 * a request in flight doesn't outlive the process, so a version not here (replaced before a restart,
 * or by an older server) has no grace left.
 */
const replacedAt = new Map<string, number>();

/**
 * Pages have no rollback: removes the versions a page no longer serves, once they were replaced
 * `graceMs` ago (or they're past MAX_PAGE_VERSIONS). After an upload, and by the reaper.
 */
async function prunePage(cfg: Config, store: Store, appId: string, graceMs = PAGE_GRACE_MS) {
  // The pointer and the versions read together, under the lock an upload publishes under.
  const todo = await selectForRemoval(store, pageLock(appId), async () => {
    const served = (await store.appById(appId, true))?.page_deploy_id; // a deleted page only needs the version a restore serves
    if (!served) return [];
    const cutoff = performance.now() - graceMs;
    const old = (await store.pageVersions(appId)).filter((d, i) =>
      d.id !== served && (i >= MAX_PAGE_VERSIONS || (replacedAt.get(d.id) ?? -Infinity) <= cutoff));
    for (const d of old) replacedAt.delete(d.id);
    return old;
  });
  await removeDeploys(cfg, store, todo);
}

/** The reaper's pass: pages (owned here) with versions they don't serve, kept by prunePage or an older server. */
export async function pruneOldPageVersions(cfg: Config, store: Store, local: (appId: string) => boolean, graceMs = PAGE_GRACE_MS) {
  for (const [id, at] of replacedAt) if (at <= performance.now() - PAGE_GRACE_MS) replacedAt.delete(id); // e.g. purged pages
  for (const appId of await store.pagesWithOldVersions()) {
    if (local(appId)) await prunePage(cfg, store, appId, graceMs);
  }
}

/** Deploys a prune is removing (until their directory has been moved aside): rollback refuses them. */
const removing = new Set<string>();
export const beingRemoved = (deployId: string) => removing.has(deployId);

/**
 * Chooses deploys to remove under `lock` and marks them before it's released (ones another prune is
 * removing are left to it). If the transaction fails, the marks go too.
 */
async function selectForRemoval(store: Store, lock: string, choose: () => Promise<Pick<Deploy, "id" | "app_id">[]>) {
  let marked: Pick<Deploy, "id" | "app_id">[] = [];
  try {
    return await store.serialized(lock, async () => {
      marked = (await choose()).filter((d) => !removing.has(d.id));
      for (const d of marked) removing.add(d.id);
      return marked;
    });
  } catch (e) {
    for (const d of marked) removing.delete(d.id);
    throw e;
  }
}

/**
 * Removes deploys `selectForRemoval` marked. The directory is first renamed aside, in one step, so nothing
 * (a rollback, even after a restart) finds a half-removed deploy; then removed, then the row. If removal
 * fails, the row stays and the next prune tries again.
 */
async function removeDeploys(cfg: Config, store: Store, todo: Pick<Deploy, "id" | "app_id">[]) {
  for (const d of todo) {
    const dir = paths(cfg, d.app_id).deploy(d.id);
    try {
      await rename(dir, `${dir}.removing`).catch((e) => {
        if (e?.code !== "ENOENT") throw e; // already moved aside by a removal that failed later
      });
      await rm(`${dir}.removing`, { recursive: true, force: true });
      await store.deleteDeploy(d.id);
    } catch (e) {
      console.error(`cresslet: couldn't remove deploy ${d.id}:`, e);
    } finally {
      removing.delete(d.id);
    }
  }
}

export async function removeAppFiles(cfg: Config, appId: string) {
  const p = paths(cfg, appId);
  await filesSettled(p.files); // writes its stopped sandbox had queued land first, then go with it
  await rm(p.app, { recursive: true, force: true });
}
