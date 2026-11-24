// The control-plane API's JSON (docs/api.md), as the studio reads it: the fields it uses. Types only: nothing
// imports this file at runtime. Timestamps are ISO strings unless noted.

export type Access = "owner" | "admin" | "viewer";
export type OrgRole = "admin" | "member";
export type Visibility = "private" | "link" | "public";

/** GET /v1 (the studio falls back to `{}` if it fails: everything may be missing). */
export interface Meta {
  appUrlTemplate?: string;
  previewOrigin?: string;
  customDomains?: boolean;
  /** `password`: email + password login. `cli`: the CLI's browser login (studio /cli). */
  auth?: { github?: boolean; password?: boolean; cli?: boolean };
  ai?: { credits?: boolean };
  /** Source control: apps can sync with GitHub. */
  git?: { github?: boolean };
}

export interface Account {
  id: string;
  email: string;
  github: string | null;
  role: "SiteAdmin" | null;
  /** It has a password (email + password login). */
  password?: boolean;
}
/** Someone named by email and GitHub login (owners, inviters). */
export interface Owner {
  email: string;
  github: string | null;
}
export interface Person extends Owner {
  id: string;
}

export interface Token {
  id: string;
  name: string;
  role: string;
  /** The apps it's limited to; null: every app. */
  apps: string[] | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  current?: boolean;
}

/** A remembered Live Link agent (GET /v1/me/agents). */
export interface RememberedAgent {
  id: string;
  label: string;
  /** The Studio browser installation that enrolled it. */
  browserInstallId: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  projects: { handle: string; projectId: string; name: string }[];
}

export interface LedgerEntry {
  kind: "usage" | "grant";
  at: string;
  credits: number;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimated?: boolean;
  usd?: number | null;
  free?: number;
  by?: string | null;
  note?: string | null;
  /** Admin listings across accounts. */
  account: { id: string; email: string };
}

/** GET /v1/me/credits */
export interface MyCredits {
  enabled: boolean;
  available: number;
  balance: number;
  monthly: { allowance: number; remaining: number; resetsAt: string };
  history: LedgerEntry[];
  /** Every ledger entry up to `historyUpTo` (`history` is one page of them). */
  historyTotal: number;
  /** The newest entry counted: pass it back as `upTo` to page through the same entries while new ones are added. */
  historyUpTo: number;
}

export interface OrgRef {
  name: string;
  title: string | null;
}

/** GET /v1/apps */
export interface AppSummary {
  id: string;
  name: string;
  url: string;
  access: Access;
  org?: OrgRef | null;
  updatedAt: string;
}

export interface Usage {
  total: number;
  deploys: number;
  database: number;
  files: number;
}

export interface DeployInfo {
  id: string;
  current?: boolean;
  createdAt: string;
  bytes: number;
  files: number;
  source: string;
  /** The project source was uploaded with it (GET /v1/apps/:name/source). */
  hasSource?: boolean;
  /** The commit it was built from (source control). */
  /** `tag`: the version tag the commit got when it deployed (`v3`). */
  git?: { sha: string; branch: string | null; repo: string | null; tag?: string | null; url: string | null } | null;
}

/** An app's linked repository (source control). */
export interface AppRepo {
  provider: "github";
  owner: string;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  subdir: string;
  deleteBranch: boolean;
  /** Submit the stack (its pull requests) after each change. */
  stackAutoSubmit: boolean;
  lastSyncedSha: string | null;
  /** The default branch's head a GitHub webhook last reported. */
  upstreamSha?: string | null;
  connectedAt: string;
}
/** GET /v1/me/git */
export interface MeGit {
  provider: "github";
  available: boolean;
  kind: "app" | "oauth" | null;
  connected: boolean;
  login: string | null;
  status: "active" | "expired" | null;
  installUrl: string | null;
}
/** GET /v1/git/github/repos */
export interface GitRepo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  push: boolean;
}
/** GET /v1/apps/:name/git/status */
export interface GitStatus {
  repo: AppRepo;
  defaultBranch: string;
  mainSha: string | null;
  branches: { name: string; sha: string; protected: boolean }[];
}

/** GET /v1/apps/:name */
export interface AppDetail {
  app: AppSummary & {
    config?: { server?: boolean; crons?: string[] } | null;
    claimed: boolean;
    expiresAt: string | null;
    currentDeployId: string | null;
    egress: string[] | null;
    createdAt: string;
  };
  runtime: { running: boolean };
  deploys: DeployInfo[];
  secrets: string[];
  /** Its linked repository, if any. */
  repo?: AppRepo | null;
}

export interface Domain {
  domain: string;
  verified: boolean;
}

/** GET /v1/apps/:name/domains: with the DNS records to set. */
export interface DomainDetail extends Domain {
  dns: { type: string; name: string; value: string }[];
}

/** One cron run (GET /v1/apps/:name/crons). `status` 0: it couldn't reach the app. */
export interface CronRun {
  cron: string;
  at: string;
  startedAt: string;
  ms: number;
  status: number;
  ok: boolean;
  manual: boolean;
}

/** GET /v1/apps/:name/crons (and what pause, resume and run answer). */
export interface Crons {
  crons: {
    cron: string;
    paused: boolean;
    /** On the node that runs it: running now, or waiting behind another run of the app. */
    state: "running" | "queued" | null;
    /** The next (up to 3) times it fires, none while paused or unclaimed. */
    next: string[];
    last: CronRun | null;
  }[];
  /** Newest first: the last 50 since `since` (when the server started). */
  runs: CronRun[];
  since: string;
}

/** GET /v1/apps/:name/metrics */
export interface Metrics {
  database: { tables: { name: string; rows: number }[]; error?: string };
  totals: { requests: number; errors: number; clientErrors: number; avgMs: number | null; maxMs: number | null };
  usage: Usage;
  since: string;
  series: { t: string; requests: number; errors: number }[];
  bucketMs: number;
  domains: Domain[];
}

/** GET /v1/apps/:name/db */
export interface DbTables {
  tables: Record<string, { count: number; schema?: string }>;
  truncated?: boolean;
}
/** POST /v1/apps/:name/db/query (values as JSON; blobs `{ $bytes: base64 }`) */
export interface DbRows {
  rows: Record<string, unknown>[];
  truncated?: boolean;
}

/** A log line (GET /v1/apps/:name/logs, JSON lines); `t`: epoch ms. */
export interface LogLine {
  t: number;
  kind: string;
  msg: string;
}

export type SiteStatus = "running" | "idle" | "empty" | "deleted";
/** GET /v1/admin/sites (and one site's `site`) */
export interface Site {
  id: string;
  name: string;
  url: string;
  status: SiteStatus;
  owner: Owner | null;
  domains: string[];
  usage: Usage;
  server?: boolean;
  crons?: number;
  currentDeploy?: DeployInfo | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  purgeAt?: string | null;
  expiresAt?: string | null;
}
export interface AdminSites {
  totals: { sites: number; live: number; anonymous: number; deleted: number; running: number; usage: Usage };
  sites: Site[];
  retentionDays: number;
}
/** GET /v1/admin/sites/:name; `database` null unless you own the site or are one of its admins. */
export interface AdminSite {
  site: Site;
  runtime: { running: boolean; pid?: number };
  deploys: DeployInfo[];
  database: { error?: string; tables: { rows: number }[] } | null;
  domains: Domain[];
  secrets: number;
}

export type AccountStatus = "active" | "invited" | "disabled";
/** GET /v1/admin/accounts */
export interface AdminAccounts {
  totals: { accounts: number; siteAdmins: number; active: number; invited: number; disabled: number };
  accounts: {
    id: string;
    email: string;
    github: string | null;
    status: AccountStatus;
    siteAdmin: boolean;
    siteAdminFromConfig?: boolean;
    orgs: { name: string; role: OrgRole }[];
    apps: number;
    lastActiveAt: string | null;
    invitedBy?: Owner | null;
  }[];
  openSignup: boolean;
}

/** GET /v1/admin/orgs */
export interface AdminOrg extends OrgRef {
  members: number;
  apps: number;
  createdAt: string;
}
/** GET /v1/orgs */
export interface MyOrg extends OrgRef {
  role: OrgRole;
}
/** GET /v1/orgs/:name; `role` null: you manage it as a site admin. */
export interface OrgDetail {
  org: OrgRef;
  role: OrgRole | null;
  canManage: boolean;
  members: (Person & { role: OrgRole; disabled?: boolean; createdAt: string })[];
  apps: { name: string; kind: "app" | "page"; url: string; updatedAt: string }[];
}

export interface CreditAccount {
  id: string;
  email: string;
  github: string | null;
  siteAdmin?: boolean;
  available: number;
  balance: number;
  monthlyUsed: number;
  used: number;
  requests: number;
  lastUsedAt: string | null;
}
/** GET /v1/admin/credits */
export interface AdminCredits {
  enabled: boolean;
  totals: {
    used: number; usd: number; requests: number; free: number; granted: number; grants: number; balance: number;
    overdrawn: number; active: number; accounts: number;
  };
  resetsAt: string;
  monthlyCredits: number;
  accounts: CreditAccount[];
  days: { date: string; credits: number; requests: number }[];
  models: { model: string; requests: number; inputTokens: number; outputTokens: number; usd: number; credits: number }[];
}
/** GET /v1/admin/credits/activity */
export interface AdminCreditActivity {
  enabled: boolean;
  /** One page, newest first. */
  entries: LedgerEntry[];
  /** Every entry up to `upTo`. */
  total: number;
  /** The newest entry counted: pass it back as `upTo` to page through the same entries while new ones are added. */
  upTo: number;
}
/** GET /v1/admin/credits/accounts/:id */
export interface AdminCreditsAccount {
  enabled: boolean;
  account: CreditAccount;
  resetsAt: string;
  monthlyCredits: number;
}

/** A file in a template or an app's uploaded source. */
export interface SourceFile {
  path: string;
  data: string;
  encoding?: "base64";
}
export interface Template {
  name: string;
  description?: string;
  /** false: CLI only (its framework's build doesn't run in the browser runtime). */
  studio?: boolean;
}

export interface Page {
  id: string;
  name: string;
  title: string | null;
  url: string;
  visibility: Visibility;
  retentionDays: number | null;
  expiresAt: string | null;
  access?: Access;
}
export interface PageDefaults {
  visibility: Visibility;
  retentionDays: number | null;
}
/** GET /v1/me/settings */
export interface Settings {
  pages: PageDefaults;
  defaults: { pages: PageDefaults };
}

/** GET /v1/me/invites */
export interface MyInvite {
  id: string;
  app: string;
  role: Access;
  invitedBy?: Owner | null;
}
/** GET /v1/apps/:name/collaborators (in an organization: `org`, and `owner` is who last held it) */
export interface Collaborators {
  org?: OrgRef | null;
  owner: Person;
  collaborators: (Person & { role: Access; createdAt: string })[];
  invites: { id: string; email: string; role: Access; createdAt: string }[];
}
