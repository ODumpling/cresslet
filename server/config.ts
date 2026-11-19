import { join, resolve } from "@std/path";

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const num = (k: string, d: number) => Number(Deno.env.get(k) ?? d);

export interface Config {
  port: number;
  /** Root domain apps live under: `<app>.<domain>`. */
  domain: string;
  /** Public base URL scheme for generated app URLs. */
  scheme: "http" | "https";
  /** Port shown in public URLs (omitted when 80/443). */
  publicPort: number;
  dataDir: string;
  sockDir: string;
  denoPath: string;
  openSignup: boolean;
  limits: {
    deployBytes: number;
    deployFiles: number;
    serverBytes: number;
    requestMs: number;
    memoryMb: number;
    idleMs: number;
    anonTtlMs: number;
    logLines: number;
  };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = num("PORT", 8787);
  const dataDir = resolve(env("CLOVER_DATA_DIR", "data"));
  const base: Config = {
    port,
    domain: env("CLOVER_DOMAIN", "localhost"),
    scheme: env("CLOVER_SCHEME", "http") as "http" | "https",
    publicPort: num("CLOVER_PUBLIC_PORT", port),
    dataDir,
    // Unix socket paths are capped at ~104 bytes on macOS, keep them short.
    sockDir: env("CLOVER_SOCK_DIR", "/tmp/clover-sock"),
    denoPath: env("CLOVER_DENO", Deno.execPath()),
    openSignup: env("CLOVER_OPEN_SIGNUP", "true") === "true",
    limits: {
      deployBytes: num("CLOVER_MAX_DEPLOY_MB", 25) * 1024 * 1024,
      deployFiles: num("CLOVER_MAX_DEPLOY_FILES", 2000),
      serverBytes: num("CLOVER_MAX_SERVER_MB", 5) * 1024 * 1024,
      requestMs: num("CLOVER_REQUEST_TIMEOUT_MS", 30_000),
      memoryMb: num("CLOVER_APP_MEMORY_MB", 256),
      idleMs: num("CLOVER_IDLE_MS", 5 * 60_000),
      anonTtlMs: num("CLOVER_ANON_TTL_HOURS", 72) * 3600_000,
      logLines: num("CLOVER_LOG_LINES", 1000),
    },
  };
  return { ...base, ...overrides, limits: { ...base.limits, ...overrides.limits } };
}

export function appUrl(cfg: Config, name: string): string {
  const defaultPort = cfg.scheme === "https" ? 443 : 80;
  const port = cfg.publicPort === defaultPort ? "" : `:${cfg.publicPort}`;
  return `${cfg.scheme}://${name}.${cfg.domain}${port}`;
}

export function rootUrl(cfg: Config): string {
  const defaultPort = cfg.scheme === "https" ? 443 : 80;
  const port = cfg.publicPort === defaultPort ? "" : `:${cfg.publicPort}`;
  return `${cfg.scheme}://${cfg.domain}${port}`;
}

export const paths = (cfg: Config, appId: string) => {
  const app = join(cfg.dataDir, "apps", appId);
  return {
    app,
    deploys: join(app, "deploys"),
    deploy: (deployId: string) => join(app, "deploys", deployId),
    data: join(app, "data"),
    db: join(app, "data", "db.sqlite"),
    files: join(app, "data", "files"),
    run: join(app, "run"),
    sock: join(cfg.sockDir, `${appId}.sock`),
  };
};
