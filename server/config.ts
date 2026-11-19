import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const env = (k: string, d: string) => process.env[k] ?? d;
const num = (k: string, d: number) => Number(process.env[k] ?? d);

/** workerd binary from the `workerd` npm package (platform-specific optional dependency). */
const bundledWorkerd = (): string => createRequire(import.meta.url)("workerd").default;

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
  workerdPath: string;
  /** Let any GitHub user create an account (off: only accounts the operator pre-created). */
  openSignup: boolean;
  /** Allow deploys that create an app without an account (they expire after anonTtlMs). */
  anonDeploys: boolean;
  /** Bearer token that may pre-create accounts / issue tokens (`POST /v1/accounts`). */
  adminToken: string | null;
  /** GitHub OAuth App (web flow for the studio, device flow for the CLI). Null = disabled. */
  github: { clientId: string; clientSecret: string; webUrl: string; apiUrl: string } | null;
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
  const dataDir = resolve(env("CRESSLET_DATA_DIR", "data"));
  const githubId = process.env.CRESSLET_GITHUB_CLIENT_ID, githubSecret = process.env.CRESSLET_GITHUB_CLIENT_SECRET;
  const base: Config = {
    port,
    domain: env("CRESSLET_DOMAIN", "localhost"),
    scheme: env("CRESSLET_SCHEME", "http") as "http" | "https",
    publicPort: num("CRESSLET_PUBLIC_PORT", port),
    dataDir,
    // Unix socket paths are capped at ~104 bytes on macOS, keep them short.
    sockDir: env("CRESSLET_SOCK_DIR", "/tmp/cresslet-sock"),
    workerdPath: process.env.CRESSLET_WORKERD ?? bundledWorkerd(),
    openSignup: env("CRESSLET_OPEN_SIGNUP", "true") === "true",
    anonDeploys: env("CRESSLET_ANON_DEPLOYS", "true") === "true",
    adminToken: process.env.CRESSLET_ADMIN_TOKEN || null,
    github: githubId && githubSecret
      ? {
        clientId: githubId,
        clientSecret: githubSecret,
        webUrl: env("CRESSLET_GITHUB_URL", "https://github.com").replace(/\/+$/, ""),
        apiUrl: env("CRESSLET_GITHUB_API_URL", "https://api.github.com").replace(/\/+$/, ""),
      }
      : null,
    limits: {
      deployBytes: num("CRESSLET_MAX_DEPLOY_MB", 25) * 1024 * 1024,
      deployFiles: num("CRESSLET_MAX_DEPLOY_FILES", 2000),
      serverBytes: num("CRESSLET_MAX_SERVER_MB", 5) * 1024 * 1024,
      requestMs: num("CRESSLET_REQUEST_TIMEOUT_MS", 30_000),
      memoryMb: num("CRESSLET_APP_MEMORY_MB", 256),
      idleMs: num("CRESSLET_IDLE_MS", 5 * 60_000),
      anonTtlMs: num("CRESSLET_ANON_TTL_HOURS", 72) * 3600_000,
      logLines: num("CRESSLET_LOG_LINES", 1000),
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
  };
};
