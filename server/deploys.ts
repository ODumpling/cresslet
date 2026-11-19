import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { type Config, paths } from "./config.ts";
import { type App, id, type Store } from "./store.ts";

export interface DeployFile {
  path: string;
  data: string;
  encoding?: "base64" | "utf8";
}

export interface DeployInput {
  files: DeployFile[];
  server?: string | null;
  config?: { routes?: string[] };
  source?: string;
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
const RESERVED = new Set(["www", "api", "studio", "admin", "app", "apps", "docs", "status", "mail"]);

export function validName(name: string) {
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

/** Write a deploy to disk and activate it. Deploys are immutable; activation swaps a pointer. */
export async function writeDeploy(cfg: Config, store: Store, app: App, input: DeployInput) {
  if (!Array.isArray(input.files)) throw new HttpError(400, "files must be an array");
  if (input.files.length > cfg.limits.deployFiles) {
    throw new HttpError(413, `too many files (max ${cfg.limits.deployFiles})`, "too_large");
  }
  const routes = normalizeRoutes(input.config?.routes);
  const deployId = id("dep");
  const dir = paths(cfg, app.id).deploy(deployId);
  const pub = join(dir, "public");
  let bytes = 0;
  const seen = new Set<string>();
  const decoded: [string, Uint8Array][] = [];
  for (const f of input.files) {
    if (typeof f?.path !== "string" || typeof f?.data !== "string") {
      throw new HttpError(400, "each file needs string path and data");
    }
    const p = safePath(f.path);
    if (seen.has(p)) throw new HttpError(400, `duplicate file: ${p}`);
    seen.add(p);
    const data = f.encoding === "base64" ? new Uint8Array(Buffer.from(f.data, "base64")) : new TextEncoder().encode(f.data);
    bytes += data.byteLength;
    if (bytes > cfg.limits.deployBytes) {
      throw new HttpError(413, `deploy exceeds ${cfg.limits.deployBytes} bytes`, "too_large");
    }
    decoded.push([p, data]);
  }
  const server = input.server ?? null;
  if (server !== null && typeof server !== "string") throw new HttpError(400, "server must be a string");
  if (server && server.length > cfg.limits.serverBytes) {
    throw new HttpError(413, "server bundle too large", "too_large");
  }

  await mkdir(pub, { recursive: true });
  for (const [p, data] of decoded) {
    await mkdir(dirname(join(pub, p)), { recursive: true });
    await writeFile(join(pub, p), data);
  }
  if (server) await writeFile(join(dir, "server.js"), server);
  const config = { routes, server: !!server };
  await writeFile(join(dir, "deploy.json"), JSON.stringify(config));

  store.addDeploy({
    id: deployId,
    app_id: app.id,
    created_at: Date.now(),
    bytes,
    file_count: decoded.length,
    has_server: server ? 1 : 0,
    source: String(input.source ?? "api").slice(0, 20),
  });
  store.setCurrentDeploy(app.id, deployId, config);
  await pruneDeploys(cfg, store, app.id, deployId);
  return { id: deployId, bytes, files: decoded.length, server: !!server };
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
  await rm(p.app, { recursive: true, force: true });
}
