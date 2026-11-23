import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolveTxt } from "node:dns/promises";
import { join, resolve } from "node:path";

const env = (k: string, d: string) => process.env[k] ?? d;
/** Settings `num` read that aren't a number, 0 or more: refused once loadConfig's own checks (with their messages) pass. */
const badNums = new Map<string, string>();
/** A blank value (`KEY=` in an env file) means the default (a typo like `512MB` would be NaN, which every `>` check
 * reads as "no limit": refused at the end of loadConfig). */
const num = (k: string, d: number) => {
  const v = process.env[k];
  const n = v === undefined || v.trim() === "" ? d : Number(v);
  if (!Number.isFinite(n) || n < 0) badNums.set(k, v!);
  return n;
};

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
export interface AiConfig {
  /** The operator's Anthropic API key (`CRESSLET_ANTHROPIC_API_KEY`). */
  apiKey: string;
  /** Anthropic API base URL (tests point it at a stub). */
  baseUrl: string;
  /** Credits charged per US dollar of Anthropic list price: 100 = a credit is a cent at cost; more is a markup. */
  creditsPerUsd: number;
  /** Free credits every account gets each calendar month (UTC); unused ones don't carry over. */
  monthlyCredits: number;
  /** Requests one account may have in flight at once (bounds how far one account can overdraw). */
  maxConcurrent: number;
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
  /**
   * Metadata database (accounts, apps, deploys, secrets…; docs/database.md): `url` null = SQLite at
   * <dataDir>/cresslet.db (CRESSLET_DATABASE_URL, a postgres:// URL, to use Postgres); `schema`: the Postgres
   * schema its tables live in (CRESSLET_DATABASE_SCHEMA). Apps' own databases stay SQLite files either way.
   */
  database: { url: string | null; schema: string };
  sockDir: string;
  workerdPath: string;
  /** Let any GitHub user create an account (off: only accounts the operator pre-created). */
  openSignup: boolean;
  /** Bearer token that may pre-create accounts / issue tokens (`POST /v1/accounts`). */
  adminToken: string | null;
  /** Emails / GitHub logins (lowercase) that are always SiteAdmin (`CRESSLET_SITE_ADMINS`, comma-separated). */
  siteAdmins: string[];
  /**
   * Email + password login (`CRESSLET_PASSWORD_LOGIN`; default: on when GitHub login is). No signup by password:
   * an account gets one from Settings (signed in another way) or from the operator (`POST /v1/accounts`).
   */
  passwordLogin: boolean;
  /** GitHub OAuth App (web flow for the studio, device flow for the CLI). Null = disabled. */
  github: { clientId: string; clientSecret: string; webUrl: string; apiUrl: string } | null;
  /**
   * Source control (server/git.ts, docs/self-hosting.md#source-control): apps sync with a GitHub repository, as the
   * signed-in user. `githubApp`: a GitHub App whose user-to-server tokens Cresslet uses (repository access per
   * installation; `CRESSLET_GITHUB_APP_*`). `oauthFallback` (`CRESSLET_GITHUB_SYNC_OAUTH_FALLBACK=true`): with no
   * GitHub App, ask the login OAuth App (`github`) for the `repo` scope instead (every repository the user can push to).
   */
  git: {
    githubApp: { appId: string; clientId: string; clientSecret: string; slug: string } | null;
    oauthFallback: boolean;
    /** Verifies GitHub's webhook deliveries (`CRESSLET_GITHUB_WEBHOOK_SECRET`; POST /v1/webhooks/github). Null = off. */
    webhookSecret: string | null;
    /** github.com and its API (`CRESSLET_GITHUB_URL`, `CRESSLET_GITHUB_API_URL`, as for login). */
    webUrl: string;
    apiUrl: string;
  };
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
  /**
   * AI credits (server/credits.ts): the studio's AI builder calls Claude through this server with the operator's
   * Anthropic API key, and each request's token usage is charged to the account in credits. Null = off: users
   * bring their own Anthropic API key, as before.
   */
  ai: AiConfig | null;
  limits: {
    deployBytes: number;
    deployFiles: number;
    serverBytes: number;
    /** Max JSON request body for deploys and page uploads (accounts for base64 + JSON overhead). */
    deployBodyBytes: number;
    /** Max JSON request body for all other control-plane API endpoints. */
    jsonBodyBytes: number;
    requestMs: number;
    memoryMb: number;
    idleMs: number;
    /** Sandboxes awake at once (0 = no cap). At the cap, a new one stops the least recently used idle one; none idle: 503. */
    maxRunningSandboxes: number;
    /** Open WebSockets on the whole instance / per app (0 = no cap); past either: 503. */
    maxWebSockets: number;
    maxWebSocketsPerApp: number;
    /** An open WebSocket is closed after this long without a byte either way (0 = never). */
    wsIdleMs: number;
    /** …and after this long in all (0 = never), so open sockets can't keep a sandbox awake forever. */
    wsMaxMs: number;
    logLines: number;
    /** How long a site deleted by a site admin stays restorable before it's purged. */
    deletedRetentionMs: number;
    /** Live apps one account may own (site admins: no limit). */
    maxAppsPerAccount: number;
    /** New apps and pages one account may create per hour (site admins: no limit). */
    createsPerHour: number;
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
  badNums.clear();
  const port = num("PORT", 8787);
  const dataDir = resolve(env("CRESSLET_DATA_DIR", "data"));
  const githubId = process.env.CRESSLET_GITHUB_CLIENT_ID, githubSecret = process.env.CRESSLET_GITHUB_CLIENT_SECRET;
  const deployBytes = num("CRESSLET_MAX_DEPLOY_MB", 25) * 1024 * 1024;
  const serverBytes = num("CRESSLET_MAX_SERVER_MB", 5) * 1024 * 1024;
  // Base64 expands binary files by 4/3, plus server bundle and JSON envelope overhead (~40 MB at defaults).
  const deriveDeployBodyBytes = (d: number, s: number) => Math.ceil((d * 4) / 3 + s + 2 * 1024 * 1024);
  const deployBodyBytes = process.env.CRESSLET_MAX_DEPLOY_BODY_MB
    ? num("CRESSLET_MAX_DEPLOY_BODY_MB", 40) * 1024 * 1024
    : deriveDeployBodyBytes(deployBytes, serverBytes);
  const base: Config = {
    port,
    domain: env("CRESSLET_DOMAIN", "localhost"),
    previewHost: env("CRESSLET_PREVIEW_HOST", `preview.${env("CRESSLET_DOMAIN", "localhost")}`),
    scheme: env("CRESSLET_SCHEME", "http") as "http" | "https",
    publicPort: num("CRESSLET_PUBLIC_PORT", port),
    dataDir,
    database: { url: process.env.CRESSLET_DATABASE_URL || null, schema: env("CRESSLET_DATABASE_SCHEMA", "public") },
    // Unix socket paths are capped at ~104 bytes on macOS, keep them short.
    sockDir: env("CRESSLET_SOCK_DIR", "/tmp/cresslet-sock"),
    workerdPath: process.env.CRESSLET_WORKERD ?? bundledWorkerd(),
    openSignup: env("CRESSLET_OPEN_SIGNUP", "true") === "true",
    adminToken: process.env.CRESSLET_ADMIN_TOKEN || null,
    passwordLogin: false, // the default follows `github`, below
    siteAdmins: env("CRESSLET_SITE_ADMINS", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    github: githubId && githubSecret
      ? {
        clientId: githubId,
        clientSecret: githubSecret,
        webUrl: env("CRESSLET_GITHUB_URL", "https://github.com").replace(/\/+$/, ""),
        apiUrl: env("CRESSLET_GITHUB_API_URL", "https://api.github.com").replace(/\/+$/, ""),
      }
      : null,
    git: {
      githubApp: process.env.CRESSLET_GITHUB_APP_CLIENT_ID && process.env.CRESSLET_GITHUB_APP_CLIENT_SECRET
        ? {
          appId: env("CRESSLET_GITHUB_APP_ID", ""),
          clientId: process.env.CRESSLET_GITHUB_APP_CLIENT_ID,
          clientSecret: process.env.CRESSLET_GITHUB_APP_CLIENT_SECRET,
          slug: env("CRESSLET_GITHUB_APP_SLUG", ""),
        }
        : null,
      oauthFallback: env("CRESSLET_GITHUB_SYNC_OAUTH_FALLBACK", "false") === "true",
      webhookSecret: process.env.CRESSLET_GITHUB_WEBHOOK_SECRET || null,
      webUrl: env("CRESSLET_GITHUB_URL", "https://github.com").replace(/\/+$/, ""),
      apiUrl: env("CRESSLET_GITHUB_API_URL", "https://api.github.com").replace(/\/+$/, ""),
    },
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
    ai: process.env.CRESSLET_ANTHROPIC_API_KEY
      ? {
        apiKey: process.env.CRESSLET_ANTHROPIC_API_KEY,
        baseUrl: env("CRESSLET_ANTHROPIC_BASE_URL", "https://api.anthropic.com").replace(/\/+$/, ""),
        creditsPerUsd: num("CRESSLET_AI_CREDITS_PER_USD", 100),
        monthlyCredits: num("CRESSLET_AI_MONTHLY_CREDITS", 0),
        maxConcurrent: num("CRESSLET_AI_MAX_CONCURRENT", 2),
      }
      : null,
    pages: {
      visibility: env("CRESSLET_PAGE_VISIBILITY", "private") as Visibility,
      // 0 = keep forever.
      retentionDays: num("CRESSLET_PAGE_RETENTION_DAYS", 30) || null,
    },
    limits: {
      deployBytes,
      deployFiles: num("CRESSLET_MAX_DEPLOY_FILES", 2000),
      serverBytes,
      deployBodyBytes,
      jsonBodyBytes: num("CRESSLET_MAX_JSON_BODY_KB", 1024) * 1024,
      requestMs: num("CRESSLET_REQUEST_TIMEOUT_MS", 30_000),
      memoryMb: num("CRESSLET_APP_MEMORY_MB", 256),
      idleMs: num("CRESSLET_IDLE_MS", 5 * 60_000),
      maxRunningSandboxes: num("CRESSLET_MAX_RUNNING_SANDBOXES", 32),
      maxWebSockets: num("CRESSLET_MAX_WEBSOCKETS", 1000),
      maxWebSocketsPerApp: num("CRESSLET_MAX_WEBSOCKETS_PER_APP", 100),
      wsIdleMs: num("CRESSLET_WS_IDLE_MS", 10 * 60_000),
      wsMaxMs: num("CRESSLET_WS_MAX_MS", 60 * 60_000),
      logLines: num("CRESSLET_LOG_LINES", 1000),
      deletedRetentionMs: num("CRESSLET_DELETED_RETENTION_DAYS", 30) * 86_400_000,
      maxAppsPerAccount: num("CRESSLET_MAX_APPS_PER_ACCOUNT", 50),
      maxPagesPerAccount: num("CRESSLET_MAX_PAGES_PER_ACCOUNT", 200),
      createsPerHour: num("CRESSLET_CREATES_PER_HOUR", 60),
      deploysPerHour: num("CRESSLET_DEPLOYS_PER_HOUR", 120),
      appDbBytes: num("CRESSLET_APP_DB_MB", 512) * 1024 * 1024,
      appFilesBytes: num("CRESSLET_APP_FILES_MB", 1024) * 1024 * 1024,
    },
  };
  const merged = { ...base, ...overrides };
  const pw = process.env.CRESSLET_PASSWORD_LOGIN?.trim();
  if (overrides.passwordLogin === undefined) merged.passwordLogin = pw ? pw === "true" : !!merged.github;
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
  const ai = merged.ai;
  if (ai) {
    if (!(Number.isFinite(ai.creditsPerUsd) && ai.creditsPerUsd > 0)) throw new Error("CRESSLET_AI_CREDITS_PER_USD must be a positive number");
    if (!(Number.isFinite(ai.monthlyCredits) && ai.monthlyCredits >= 0)) throw new Error("CRESSLET_AI_MONTHLY_CREDITS must be 0 or more");
    if (!(Number.isSafeInteger(ai.maxConcurrent) && ai.maxConcurrent >= 1)) throw new Error("CRESSLET_AI_MAX_CONCURRENT must be a whole number, 1 or more");
  }
  const limits = { ...base.limits, ...overrides.limits };
  if (overrides.limits?.deployBodyBytes === undefined && !process.env.CRESSLET_MAX_DEPLOY_BODY_MB &&
      (overrides.limits?.deployBytes !== undefined || overrides.limits?.serverBytes !== undefined)) {
    limits.deployBodyBytes = deriveDeployBodyBytes(limits.deployBytes, limits.serverBytes);
  }
  if (!Number.isSafeInteger(limits.deployBodyBytes) || limits.deployBodyBytes < 1) {
    throw new Error("CRESSLET_MAX_DEPLOY_BODY_MB / limits.deployBodyBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limits.jsonBodyBytes) || limits.jsonBodyBytes < 1) {
    throw new Error("CRESSLET_MAX_JSON_BODY_KB / limits.jsonBodyBytes must be a positive safe integer");
  }
  for (const [k, env] of [["maxRunningSandboxes", "CRESSLET_MAX_RUNNING_SANDBOXES"], ["maxWebSockets", "CRESSLET_MAX_WEBSOCKETS"],
    ["maxWebSocketsPerApp", "CRESSLET_MAX_WEBSOCKETS_PER_APP"], ["wsIdleMs", "CRESSLET_WS_IDLE_MS"], ["wsMaxMs", "CRESSLET_WS_MAX_MS"]] as const) {
    // Timers past 2^31-1 ms fire at once in Node.
    if (!(Number.isSafeInteger(limits[k]) && limits[k] >= 0 && limits[k] <= 2 ** 31 - 1)) {
      throw new Error(`${env} must be a whole number from 0 (no limit) to ${2 ** 31 - 1}`);
    }
  }
  const database = { ...base.database, ...overrides.database };
  if (database.url && !/^postgres(ql)?:\/\//.test(database.url)) throw new Error("CRESSLET_DATABASE_URL must be a postgres:// URL");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database.schema)) {
    throw new Error("CRESSLET_DATABASE_SCHEMA must be a lowercase identifier (a-z, 0-9, _)");
  }
  // Test runs against Postgres (npm run test:pg): each data dir gets its own schema, as it gets its own SQLite file.
  if (database.url && process.env.CRESSLET_TEST_SCHEMA_PER_DATA_DIR === "1" && !overrides.database?.schema) {
    database.schema = "t_" + createHash("sha256").update(merged.dataDir).digest("hex").slice(0, 16);
  }
  for (const [k, v] of badNums) throw new Error(`${k} must be a number, 0 or more (got ${JSON.stringify(v)})`);
  const git = { ...base.git, ...overrides.git };
  return {
    ...merged,
    git,
    database,
    pages,
    sandbox: { ...base.sandbox, ...overrides.sandbox },
    limits,
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

/**
 * The studio's session cookie (server/api.ts): an account token, HttpOnly. `__Host-`: only the studio's host can set
 * it (not an app under the domain).
 */
export const sessionCookie = (cfg: Config) => cfg.scheme === "https" ? "__Host-cresslet_session" : "cresslet_session";
/**
 * The session cookie in a `Cookie` header, if it's there once. Twice: over http an app under the domain can set one
 * for the whole domain (no `__Host-`), and which one the studio set can't be told, so neither counts.
 */
export function sessionCookieValue(cfg: Config, header: string | undefined): string | undefined {
  const name = sessionCookie(cfg);
  const values = (header ?? "").split(";").flatMap((part) => {
    const i = part.indexOf("=");
    return i > 0 && part.slice(0, i).trim() === name ? [part.slice(i + 1).trim()] : [];
  });
  return values.length === 1 ? values[0] : undefined;
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
 * Startup warnings for an instance where strangers can deploy code (open signup with GitHub
 * login) without the isolation that needs: gVisor (per sandbox or around the whole server), and
 * one uid per app unless each sandbox has its own gVisor.
 */
export function isolationWarnings(cfg: Config): string[] {
  if (!(cfg.openSignup && cfg.github)) return [];
  const { runsc, outerGvisor, uidBase } = cfg.sandbox;
  const out: string[] = [];
  if (!runsc && !outerGvisor) {
    out.push("cresslet: strangers can deploy code here (open signup) but CRESSLET_RUNSC is unset and " +
      "CRESSLET_OUTER_GVISOR isn't true; workerd alone isn't a hardened multi-tenant boundary. Set CRESSLET_RUNSC, or run the server under gVisor " +
      "(docker --runtime=runsc) and set CRESSLET_OUTER_GVISOR=true (docs/self-hosting.md#docker-and-isolation)");
  }
  if (uidBase === null && !runsc) {
    out.push("cresslet: strangers can deploy code here (open signup) but sandboxes share one uid: " +
      "set CRESSLET_SANDBOX_UID_BASE and/or CRESSLET_RUNSC (docs/self-hosting.md#docker-and-isolation)");
  }
  return out;
}
