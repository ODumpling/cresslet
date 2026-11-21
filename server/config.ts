import { createRequire } from "node:module";
import { resolveTxt } from "node:dns/promises";
import { join, resolve } from "node:path";

const env = (k: string, d: string) => process.env[k] ?? d;
const num = (k: string, d: number) => Number(process.env[k] ?? d);

/** workerd binary from the `workerd` npm package (platform-specific optional dependency). */
const bundledWorkerd = (): string => createRequire(import.meta.url)("workerd").default;

/** Who can open a page: signed-in owner and collaborators, anyone with the link (not indexed), or anyone (indexed). */
export const VISIBILITIES = ["private", "link", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export interface PageDefaults {
  visibility: Visibility;
  /** Days a page is kept after its last upload or retention change; null = forever. */
  retentionDays: number | null;
}
/** Longest retention that can be set (anything longer: keep forever). */
export const MAX_RETENTION_DAYS = 3650;

export interface Config {
  port: number;
  /** Root domain apps live under: `<app>.<domain>`. */
  domain: string;
  /** Host that serves studio previews, isolated from the studio's origin (default `preview.<domain>`). */
  previewHost: string;
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
  /** Emails / GitHub logins (lowercase) that are always SiteAdmin (`CRESSLET_SITE_ADMINS`, comma-separated). */
  siteAdmins: string[];
  /** GitHub OAuth App (web flow for the studio, device flow for the CLI). Null = disabled. */
  github: { clientId: string; clientSecret: string; webUrl: string; apiUrl: string } | null;
  /**
   * Request header with the real client IP (e.g. `cf-connecting-ip` behind Cloudflare), for per-IP
   * limits. Only set it when every request comes through that proxy: clients can send it too.
   */
  clientIpHeader: string | null;
  /**
   * Let apps add and verify custom domains (`CRESSLET_CUSTOM_DOMAINS`, default on). Turn it off when
   * nothing in front can route and certify other people's hostnames, e.g. Cloudflare's proxy + Traefik
   * on Coolify. Domains verified earlier keep routing.
   */
  customDomains: boolean;
  /** TXT lookup for custom-domain verification (tests stub it). */
  resolveTxt: (name: string) => Promise<string[][]>;
  /** OS-level sandbox limits (server/sandbox.ts); Linux, opt-in. */
  sandbox: {
    uidBase: number | null;
    cgroupDir: string | null;
    cpuPercent: number;
    pidsMax: number;
    /** gVisor's `runsc` binary: run each sandbox under gVisor (null = off; unset in overrides = from env). */
    runsc?: string | null;
    /**
     * The operator's word that the whole server already runs under gVisor (e.g. Docker
     * `--runtime=runsc`, as deploy/coolify does). Only silences the startup warning; changes nothing else.
     */
    outerGvisor?: boolean;
  };
  /** Server-wide defaults for pages; each account can override them (`PUT /v1/me/settings`). */
  pages: PageDefaults;
  limits: {
    deployBytes: number;
    deployFiles: number;
    serverBytes: number;
    requestMs: number;
    memoryMb: number;
    idleMs: number;
    anonTtlMs: number;
    logLines: number;
    /** How long a site deleted by a site admin stays restorable before it's purged. */
    deletedRetentionMs: number;
    /** Live apps one account may own (site admins: no limit). */
    maxAppsPerAccount: number;
    /** Live unclaimed (anonymous) apps on the whole instance. */
    maxAnonApps: number;
    /** Anonymous apps one client IP may create per hour. */
    anonAppsPerHour: number;
    /** Deploys per app per hour. */
    deploysPerHour: number;
    /** Live pages (uploaded static HTML) one account may own (site admins: no limit). */
    maxPagesPerAccount: number;
    /** Size cap of an app's database (SQLite max_page_count). */
    appDbBytes: number;
    /** Total size of an app's stored files (env.files). */
    appFilesBytes: number;
  };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const port = num("PORT", 8787);
  const dataDir = resolve(env("CRESSLET_DATA_DIR", "data"));
  const githubId = process.env.CRESSLET_GITHUB_CLIENT_ID, githubSecret = process.env.CRESSLET_GITHUB_CLIENT_SECRET;
  const base: Config = {
    port,
    domain: env("CRESSLET_DOMAIN", "localhost"),
    previewHost: env("CRESSLET_PREVIEW_HOST", `preview.${env("CRESSLET_DOMAIN", "localhost")}`),
    scheme: env("CRESSLET_SCHEME", "http") as "http" | "https",
    publicPort: num("CRESSLET_PUBLIC_PORT", port),
    dataDir,
    // Unix socket paths are capped at ~104 bytes on macOS, keep them short.
    sockDir: env("CRESSLET_SOCK_DIR", "/tmp/cresslet-sock"),
    workerdPath: process.env.CRESSLET_WORKERD ?? bundledWorkerd(),
    openSignup: env("CRESSLET_OPEN_SIGNUP", "true") === "true",
    anonDeploys: env("CRESSLET_ANON_DEPLOYS", "true") === "true",
    adminToken: process.env.CRESSLET_ADMIN_TOKEN || null,
    siteAdmins: env("CRESSLET_SITE_ADMINS", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    github: githubId && githubSecret
      ? {
        clientId: githubId,
        clientSecret: githubSecret,
        webUrl: env("CRESSLET_GITHUB_URL", "https://github.com").replace(/\/+$/, ""),
        apiUrl: env("CRESSLET_GITHUB_API_URL", "https://api.github.com").replace(/\/+$/, ""),
      }
      : null,
    clientIpHeader: process.env.CRESSLET_CLIENT_IP_HEADER?.trim().toLowerCase() || null,
    customDomains: env("CRESSLET_CUSTOM_DOMAINS", "true") === "true",
    resolveTxt,
    sandbox: {
      uidBase: process.env.CRESSLET_SANDBOX_UID_BASE ? num("CRESSLET_SANDBOX_UID_BASE", 0) : null,
      cgroupDir: process.env.CRESSLET_CGROUP_DIR || null,
      cpuPercent: num("CRESSLET_APP_CPU_PERCENT", 100),
      pidsMax: num("CRESSLET_APP_PIDS", 256),
      runsc: process.env.CRESSLET_RUNSC || null,
      outerGvisor: env("CRESSLET_OUTER_GVISOR", "false") === "true",
    },
    pages: {
      visibility: env("CRESSLET_PAGE_VISIBILITY", "private") as Visibility,
      // 0 = keep forever.
      retentionDays: num("CRESSLET_PAGE_RETENTION_DAYS", 30) || null,
    },
    limits: {
      deployBytes: num("CRESSLET_MAX_DEPLOY_MB", 25) * 1024 * 1024,
      deployFiles: num("CRESSLET_MAX_DEPLOY_FILES", 2000),
      serverBytes: num("CRESSLET_MAX_SERVER_MB", 5) * 1024 * 1024,
      requestMs: num("CRESSLET_REQUEST_TIMEOUT_MS", 30_000),
      memoryMb: num("CRESSLET_APP_MEMORY_MB", 256),
      idleMs: num("CRESSLET_IDLE_MS", 5 * 60_000),
      anonTtlMs: num("CRESSLET_ANON_TTL_HOURS", 72) * 3600_000,
      logLines: num("CRESSLET_LOG_LINES", 1000),
      deletedRetentionMs: num("CRESSLET_DELETED_RETENTION_DAYS", 30) * 86_400_000,
      maxAppsPerAccount: num("CRESSLET_MAX_APPS_PER_ACCOUNT", 50),
      maxAnonApps: num("CRESSLET_MAX_ANON_APPS", 200),
      maxPagesPerAccount: num("CRESSLET_MAX_PAGES_PER_ACCOUNT", 200),
      anonAppsPerHour: num("CRESSLET_ANON_APPS_PER_HOUR", 10),
      deploysPerHour: num("CRESSLET_DEPLOYS_PER_HOUR", 120),
      appDbBytes: num("CRESSLET_APP_DB_MB", 512) * 1024 * 1024,
      appFilesBytes: num("CRESSLET_APP_FILES_MB", 1024) * 1024 * 1024,
    },
  };
  const merged = { ...base, ...overrides };
  if (overrides.domain && !overrides.previewHost && !process.env.CRESSLET_PREVIEW_HOST) merged.previewHost = `preview.${overrides.domain}`;
  merged.domain = merged.domain.trim().toLowerCase().replace(/\.$/, "");
  merged.previewHost = merged.previewHost.trim().toLowerCase().replace(/\.$/, "");
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const parsed = (() => {
    try {
      return new URL(`http://${merged.previewHost}`).hostname;
    } catch {
      return null;
    }
  })();
  // Must survive URL parsing unchanged (rejects e.g. `preview.123`, `127.1`): routing and the origin use it as is.
  if (parsed !== merged.previewHost || !merged.previewHost.split(".").every((l) => label.test(l)) || merged.previewHost === merged.domain) {
    throw new Error("CRESSLET_PREVIEW_HOST must be a bare hostname (no scheme or port), different from CRESSLET_DOMAIN");
  }
  const pages = { ...base.pages, ...overrides.pages };
  if (!VISIBILITIES.includes(pages.visibility)) throw new Error(`CRESSLET_PAGE_VISIBILITY must be one of ${VISIBILITIES.join(", ")}`);
  if (pages.retentionDays !== null && !(Number.isInteger(pages.retentionDays) && pages.retentionDays >= 1 && pages.retentionDays <= MAX_RETENTION_DAYS)) {
    throw new Error(`CRESSLET_PAGE_RETENTION_DAYS must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}, or 0 (forever)`);
  }
  return {
    ...merged,
    pages,
    sandbox: { ...base.sandbox, ...overrides.sandbox },
    limits: { ...base.limits, ...overrides.limits },
  };
}

export function appUrl(cfg: Config, name: string): string {
  const defaultPort = cfg.scheme === "https" ? 443 : 80;
  const port = cfg.publicPort === defaultPort ? "" : `:${cfg.publicPort}`;
  return `${cfg.scheme}://${name}.${cfg.domain}${port}`;
}

/** The app name the preview host shadows (`preview` for `preview.<domain>`), if it's under the domain. */
export function previewAppName(cfg: Config): string | null {
  const suffix = "." + cfg.domain;
  const sub = cfg.previewHost.endsWith(suffix) ? cfg.previewHost.slice(0, -suffix.length) : "";
  return sub && !sub.includes(".") ? sub : null;
}

export function previewOrigin(cfg: Config): string {
  const defaultPort = cfg.scheme === "https" ? 443 : 80;
  const port = cfg.publicPort === defaultPort ? "" : `:${cfg.publicPort}`;
  return `${cfg.scheme}://${cfg.previewHost}${port}`;
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
  };
};

/**
 * Startup warnings for an instance where strangers can deploy code (open signup or anonymous
 * deploys) without the isolation that needs: gVisor (per sandbox or around the whole server), and
 * one uid per app unless each sandbox has its own gVisor.
 */
export function isolationWarnings(cfg: Config): string[] {
  if (!(cfg.anonDeploys || (cfg.openSignup && cfg.github))) return [];
  const { runsc, outerGvisor, uidBase } = cfg.sandbox;
  const out: string[] = [];
  if (!runsc && !outerGvisor) {
    out.push("cresslet: strangers can deploy code here (open signup or anonymous deploys) but CRESSLET_RUNSC is unset and " +
      "CRESSLET_OUTER_GVISOR isn't true; workerd alone isn't a hardened multi-tenant boundary. Set CRESSLET_RUNSC, or run the server under gVisor " +
      "(docker --runtime=runsc) and set CRESSLET_OUTER_GVISOR=true (docs/self-hosting.md#docker-and-isolation)");
  }
  if (uidBase === null && !runsc) {
    out.push("cresslet: strangers can deploy code here (open signup or anonymous deploys) but sandboxes share one uid: " +
      "set CRESSLET_SANDBOX_UID_BASE and/or CRESSLET_RUNSC (docs/self-hosting.md#docker-and-isolation)");
  }
  return out;
}
