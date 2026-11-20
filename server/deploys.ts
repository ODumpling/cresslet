import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { type Config, paths, previewAppName } from "./config.ts";
import { type App, id, type Store } from "./store.ts";
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
}

/** Never stored as source: local secrets, build output, dependencies, VCS. */
const NOT_SOURCE = /(?:^|\/)(?:node_modules|\.git|\.cresslet|\.env[^/]*)\/|^dist\/|(?:^|\/)\.env[^/]*(?:local|cresslet)[^/]*$|(?:^|\/)(?:\.envrc[^/]*|\.dev\.vars(?:[._-][^/]*)?)$/i;
// Any .env-prefixed file (sanitized: only public entries kept).
const DOTENV = /(?:^|\/)\.env[^/]*$/i;
/** Other dotenv files keep only what the build exposes to the client anyway (docs/app-format.md). */
function publicDotenv(data: Uint8Array): Uint8Array {
  return new TextEncoder().encode(publicDotenvText(new TextDecoder().decode(data)));
}
/**
 * Fail closed: dotenv parsers differ (multi-line quotes, escapes, values starting on the next line, `KEY: v`), so
 * only lines that every parser reads as one complete single-line entry are understood: `NAME=value`, a non-empty
 * unquoted value or a backslash-free single-line '…' / "…", optional `# comment`. Public ones (CRESSLET_PUBLIC_*,
 * VITE_*) are kept verbatim, comments are dropped, and the first line not understood ends the file.
 */
const SAFE_ENTRY = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*=[ \t]*(?:[^\s"'\x60\\#][^"'\x60\\\r\n#]*|"[^"\\\r\n]*"|'[^'\\\r\n]*')[ \t]*(?:#[^"'\x60\\\r\n]*)?$/;
export function publicDotenvText(text: string): string {
  const out: string[] = [];
  for (const l of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/[\r\u2028\u2029]/.test(l)) break; // a line break to some parsers, not to others
    if (/^[ \t]*$/.test(l)) out.push(l);
    else if (!/^[ \t]*#/.test(l)) {
      const m = SAFE_ENTRY.exec(l);
      if (!m) break; // anything else may open a value that runs on: drop it and the rest
      if (/^(?:CRESSLET_PUBLIC_|VITE_)/.test(m[1])) out.push(l);
    }
  }
  return out.join("\n");
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(["www", "api", "studio", "admin", "app", "apps", "docs", "status", "mail", "preview"]);

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
    if (typeof r !== "string" || !r.startsWith("/") || r.length > 200) {
      throw new HttpError(400, `invalid route: ${r}`);
    }
    return r;
  });
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

  store.addDeploy({
    id: deployId,
    app_id: app.id,
    created_at: Date.now(),
    bytes: bytes + sources.bytes,
    file_count: decoded.length,
    has_server: server ? 1 : 0,
    source: String(input.source ?? "api").slice(0, 20),
  });
  store.setCurrentDeploy(app.id, deployId, config);
  await pruneDeploys(cfg, store, app.id, deployId);
  return { id: deployId, bytes, files: decoded.length, server: !!server, ...(warning ? { warning } : {}) };
}

/** Keep the 10 most recent deploys for rollback. */
async function pruneDeploys(cfg: Config, store: Store, appId: string, keep: string) {
  const all = store.deploys(appId, 1000);
  for (const d of all.slice(10)) {
    if (d.id === keep) continue;
    store.deleteDeploy(d.id);
    await rm(paths(cfg, appId).deploy(d.id), { recursive: true, force: true });
  }
}

export async function removeAppFiles(cfg: Config, appId: string) {
  const p = paths(cfg, appId);
  await filesSettled(p.files); // writes its stopped sandbox had queued land first, then go with it
  await rm(p.app, { recursive: true, force: true });
}
