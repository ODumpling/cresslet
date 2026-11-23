// Site admin API (/v1/admin): every site on the server, its disk and database usage, delete/restore/purge; AI credit
// usage across accounts, and grants.
// Allowed for accounts with the SiteAdmin role (or listed in CRESSLET_SITE_ADMINS) and the operator's admin token.
import type { Context, Hono } from "hono";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { appUrl, type Config, paths } from "./config.ts";
import { type Account, type AiAccountRow, type App, ORG_ROLES, orgLock, type OrgRole, SITE_ADMIN, type Store, type Token } from "./store.ts";
import { credits as toCredits, ledgerEntry, ledgerPage, nextPeriod, period, periodStart } from "./credits.ts";
import type { Runtime } from "./runtime.ts";
import { inspect } from "./inspect.ts";
import { HttpError, KEEP_DEPLOYS, removeAppFiles } from "./deploys.ts";

export type Env = { Bindings: { remoteAddr?: string }; Variables: { account?: Account; token?: Token; bearer?: string } };

/** Listed in CRESSLET_SITE_ADMINS (by email or GitHub login): a site admin whatever its role says. */
export const isEnvSiteAdmin = (cfg: Config, a: Account) =>
  cfg.siteAdmins.includes((a.disabled_email ?? a.email).toLowerCase()) ||
  (!!a.github_login && cfg.siteAdmins.includes(a.github_login.toLowerCase()));

export const isSiteAdmin = (cfg: Config, a: Account | undefined) =>
  !!a && !a.disabled_at && (a.role === SITE_ADMIN || isEnvSiteAdmin(cfg, a));

/**
 * Who is acting as site admin, for log lines (`id`: their account, null for the operator token), or null if the
 * request isn't. Only with a full-access token: a site admin's scoped token (read, deploy, some apps) doesn't count.
 */
export function siteAdminActor(cfg: Config, c: Context<Env>, isAdminToken: (bearer?: string) => boolean) {
  const acct = c.get("account"), t = c.get("token");
  if (isSiteAdmin(cfg, acct) && t?.role === "admin" && !t.apps) return { who: acct!.github_login ?? acct!.email, id: acct!.id };
  if (isAdminToken(c.get("bearer"))) return { who: "operator", id: null };
  return null;
}

/** Permanently removes an app: process, rows (deploys, secrets, domains cascade), logs, files. */
export async function purgeApp(cfg: Config, store: Store, runtime: Runtime, a: App) {
  await store.deleteApp(a.id); // first: no new request starts its sandbox
  try {
    await runtime.stopSettled(a.id);
  } finally {
    runtime.logs.drop(a.id);
    runtime.metrics.drop(a.id);
    runtime.cronRuns.drop(a.id);
    await removeAppFiles(cfg, a.id); // no row is left to retry from
  }
}

/** Bytes under a directory (files only, symlinks not followed); 0 if it doesn't exist. */
async function dirBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    total += await lstat(join(e.parentPath, e.name)).then((s) => s.size, () => 0);
  }
  return total;
}

const fileBytes = (p: string) => lstat(p).then((s) => s.size, () => 0);

export async function usage(cfg: Config, appId: string) {
  const p = paths(cfg, appId);
  const [deploys, files, db, wal, shm] = await Promise.all([
    dirBytes(p.deploys),
    dirBytes(p.files),
    fileBytes(p.db),
    fileBytes(p.db + "-wal"),
    fileBytes(p.db + "-shm"),
  ]);
  const database = db + wal + shm;
  return { deploys, database, files, total: deploys + database + files };
}

/**
 * Checks again (after a request body arrived, right before the write; inside its transaction where it has one)
 * that the caller is still a site admin: its token not revoked, its account not disabled or demoted. The operator token always is.
 */
export async function stillSiteAdmin(cfg: Config, store: Store, c: Context<Env>) {
  const acct = c.get("account"), t = c.get("token");
  if (!acct || !t) return; // the operator token
  const now = await store.accountById(acct.id);
  if (!(await store.tokens(acct.id)).some((x) => x.id === t.id) || !isSiteAdmin(cfg, now)) {
    throw new HttpError(403, "site admin only", "forbidden");
  }
}

export function adminRoutes(
  app: Hono<Env>,
  { cfg, store, runtime, isAdminToken, body }: {
    cfg: Config;
    store: Store;
    runtime: Runtime;
    isAdminToken: (bearer?: string) => boolean;
    body: <T>(c: Context<Env>) => Promise<T>;
  },
) {
  /** Who is acting, for log lines; throws unless a site admin. */
  const requireSiteAdmin = (c: Context<Env>) => {
    const actor = siteAdminActor(cfg, c, isAdminToken);
    if (actor) return actor.who;
    const acct = c.get("account");
    throw new HttpError(acct ? 403 : 401, "site admin only", acct ? "forbidden" : "unauthorized");
  };

  const getSite = async (name: string) => {
    const a = await store.appByName(name, true);
    if (!a) throw new HttpError(404, `site not found: ${name}`, "not_found");
    return a;
  };

  const owners = new Map<string, Account | undefined>();
  const owner = async (id: string | null) => {
    if (!id) return null;
    if (!owners.has(id)) owners.set(id, await store.accountById(id));
    const o = owners.get(id);
    return o ? { id: o.id, email: o.disabled_email ?? o.email, github: o.github_login } : null;
  };

  const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
  const siteView = async (a: App) => {
    const config = JSON.parse(a.config) as { server?: boolean; crons?: string[] };
    const rt = runtime.status(a.id);
    const served = a.current_deploy_id ?? a.page_deploy_id;
    const deploy = served ? await store.deploy(served) : undefined;
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      ...(a.kind === "page" ? { visibility: a.visibility } : {}),
      url: appUrl(cfg, a.name),
      status: a.deleted_at ? "deleted" : rt.running ? "running" : served ? "idle" : "empty",
      owner: await owner(a.account_id),
      org: a.org_id ? await store.orgById(a.org_id).then((o) => (o ? { name: o.name, title: o.title } : null)) : null,
      server: !!config.server,
      crons: config.crons?.length ?? 0,
      domains: (await store.domains(a.id)).filter((d) => d.verified_at).map((d) => d.domain),
      currentDeploy: deploy
        ? { id: deploy.id, createdAt: iso(deploy.created_at), bytes: deploy.bytes, files: deploy.file_count, source: deploy.source }
        : null,
      usage: await usage(cfg, a.id),
      expiresAt: iso(a.expires_at),
      deletedAt: iso(a.deleted_at),
      purgeAt: a.deleted_at ? iso(a.deleted_at + cfg.limits.deletedRetentionMs) : null,
      createdAt: iso(a.created_at),
      updatedAt: iso(a.updated_at),
    };
  };

  app.get("/admin/sites", async (c) => {
    requireSiteAdmin(c);
    owners.clear();
    const sites = await Promise.all((await store.allApps()).map(siteView));
    const sum = (k: "deploys" | "database" | "files" | "total") => sites.reduce((n, s) => n + s.usage[k], 0);
    return c.json({
      totals: {
        sites: sites.length,
        live: sites.filter((s) => s.status !== "deleted").length,
        running: sites.filter((s) => s.status === "running").length,
        deleted: sites.filter((s) => s.status === "deleted").length,
        anonymous: sites.filter((s) => !s.owner && s.status !== "deleted").length,
        usage: { deploys: sum("deploys"), database: sum("database"), files: sum("files"), total: sum("total") },
      },
      retentionDays: cfg.limits.deletedRetentionMs / 86_400_000,
      sites,
    });
  });

  app.get("/admin/sites/:name", async (c) => {
    requireSiteAdmin(c);
    owners.clear();
    const a = await getSite(c.req.param("name"));
    // Site admin powers cover the site, not its data: the tables are only shown to whoever runs the app
    // (its owner, or an admin it invited).
    let database: { tables: { name: string; rows: number }[]; error: string | null; truncated?: true } | null = null;
    // requireSiteAdmin already demands a full-access token (admin role, every app).
    const acct = c.get("account"), access = acct ? await store.access(a, acct.id) : undefined;
    if (access === "owner" || access === "admin") {
      database = { tables: [], error: null };
      try {
        const r = await inspect<{ tables: { name: string; rows: number }[]; truncated: boolean }>(a.id, paths(cfg, a.id).db, { kind: "counts" });
        database.tables = r?.tables ?? [];
        if (r?.truncated) database.truncated = true;
      } catch (e) {
        database.error = (e as Error).message;
      }
    }
    return c.json({
      site: await siteView(a),
      deploys: (await store.deploys(a.id, KEEP_DEPLOYS)).map((d) => ({
        id: d.id,
        createdAt: iso(d.created_at),
        bytes: d.bytes,
        files: d.file_count,
        server: !!d.has_server,
        source: d.source,
        current: d.id === (a.current_deploy_id ?? a.page_deploy_id),
      })),
      domains: (await store.domains(a.id)).map((d) => ({ domain: d.domain, verified: !!d.verified_at })),
      secrets: (await store.secretKeys(a.id)).length,
      database,
      runtime: runtime.status(a.id),
    });
  });

  // Soft delete: offline right away (not served, no crons, owner sees 404), restorable until purged.
  // `?purge=1` deletes it permanently now.
  app.delete("/admin/sites/:name", async (c) => {
    const who = requireSiteAdmin(c);
    const a = await getSite(c.req.param("name"));
    if (c.req.query("purge") === "1") {
      await purgeApp(cfg, store, runtime, a);
      console.log(`cresslet: site ${a.name} purged by ${who}`);
      return c.json({ purged: a.name });
    }
    if (!a.deleted_at) {
      await store.setDeleted(a.id, Date.now()); // first: no request starts it again after the stop
      runtime.stop(a.id);
      runtime.logs.push(a.id, "system", `site deleted by site admin ${who}`);
    }
    return c.json({ site: await siteView((await store.appById(a.id, true))!) });
  });

  app.post("/admin/sites/:name/restore", async (c) => {
    const who = requireSiteAdmin(c);
    const a = await getSite(c.req.param("name"));
    if (a.deleted_at) {
      await store.setDeleted(a.id, null);
      runtime.logs.push(a.id, "system", `site restored by site admin ${who}`);
    }
    return c.json({ site: await siteView((await store.appById(a.id))!) });
  });

  // ---- accounts: every account on the server; invite (set one up before they sign in), disable, site admin role.
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  /** Invited: set up by a site admin, not signed in yet. */
  const accountStatus = (a: Account) => (a.disabled_at ? "disabled" : a.invited_at ? "invited" : "active");
  const accountRow = async (a: Account & { last_used_at: number | null; tokens: number; apps: number }) => ({
    id: a.id,
    email: a.disabled_email ?? a.email,
    github: a.github_login,
    status: accountStatus(a),
    siteAdmin: a.role === SITE_ADMIN || isEnvSiteAdmin(cfg, a),
    // Listed in CRESSLET_SITE_ADMINS: a site admin whatever its role, changed in the server's config only.
    siteAdminFromConfig: isEnvSiteAdmin(cfg, a),
    apps: a.apps,
    orgs: (await store.orgsFor(a.id)).map((o) => ({ name: o.name, title: o.title, role: o.role })),
    invitedBy: await owner(a.invited_by),
    createdAt: iso(a.created_at),
    lastActiveAt: iso(a.last_used_at),
    disabledAt: iso(a.disabled_at),
  });
  const accountRowById = async (id: string) => {
    const a = (await store.allAccounts()).find((x) => x.id === id);
    if (!a) throw new HttpError(404, "account not found", "not_found");
    return accountRow(a);
  };
  const getAccount = async (id: string) => {
    const a = await store.accountById(id);
    if (!a) throw new HttpError(404, "account not found", "not_found");
    return a;
  };
  /** Role and disabling: not your own account (no locking yourself out), not one the server's config makes an admin. */
  const changeable = (c: Context<Env>, a: Account, what: string) => {
    if (a.id === c.get("account")?.id) throw new HttpError(400, `you can't ${what} your own account`);
    if (isEnvSiteAdmin(cfg, a)) throw new HttpError(400, `${a.disabled_email ?? a.email} is a site admin in the server's config (CRESSLET_SITE_ADMINS): change it there`, "config_admin");
  };
  const setSiteAdmin = async (c: Context<Env>, who: string, a: Account, on: boolean) => {
    if (!on) changeable(c, a, "remove the site admin role from");
    await store.setRole(a.id, on ? SITE_ADMIN : null);
    console.log(`cresslet: ${a.disabled_email ?? a.email} role ${on ? SITE_ADMIN : "(none)"} set by ${who}`);
  };

  app.get("/admin/accounts", async (c) => {
    requireSiteAdmin(c);
    owners.clear();
    const accounts = await Promise.all((await store.allAccounts()).map(accountRow));
    const count = (s: string) => accounts.filter((a) => a.status === s).length;
    return c.json({
      totals: { accounts: accounts.length, active: count("active"), invited: count("invited"), disabled: count("disabled"), siteAdmins: accounts.filter((a) => a.siteAdmin).length },
      openSignup: cfg.openSignup,
      accounts,
    });
  });

  // Invite: sets up an account for this email. They sign in with GitHub (any verified email on their GitHub
  // account matching), also while signup is closed. No email is sent. `org`, `orgRole`: add it to an organization.
  app.post("/admin/accounts", async (c) => {
    const who = requireSiteAdmin(c);
    const input = await body<{ email?: unknown; siteAdmin?: unknown; org?: unknown; orgRole?: unknown } | null>(c) ?? {};
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "valid email required");
    if (input.siteAdmin !== undefined && typeof input.siteAdmin !== "boolean") throw new HttpError(400, "siteAdmin must be true or false");
    let org: { id: string; name: string } | undefined, orgRole: OrgRole = "member";
    if (input.org != null) {
      org = typeof input.org === "string" ? await store.orgByName(input.org) : undefined;
      if (!org) throw new HttpError(404, `organization not found: ${String(input.org)}`, "not_found");
      if (input.orgRole !== undefined && !ORG_ROLES.includes(input.orgRole as OrgRole)) throw new HttpError(400, `orgRole must be one of ${ORG_ROLES.join(", ")}`);
      orgRole = (input.orgRole as OrgRole | undefined) ?? "member";
    }
    const acct = await store.serialized("cresslet:invite-account", async () => {
      await stillSiteAdmin(cfg, store, c);
      if (await store.accountByEmail(email) || await store.disabledAccount({ emails: [email] })) {
        throw new HttpError(409, `${email} already has an account`, "conflict");
      }
      if (org) {
        await store.db.lock(orgLock(org.id)); // as member changes and deleting it do
        if (!await store.orgById(org.id)) throw new HttpError(404, `organization not found: ${org.name}`, "not_found");
      }
      const a = await store.createAccount(email, undefined, { by: c.get("account")?.id ?? null });
      if (input.siteAdmin === true) await store.setRole(a.id, SITE_ADMIN);
      if (org) await store.setOrgMember(org.id, a.id, orgRole);
      return a;
    });
    console.log(`cresslet: ${email} invited by ${who}${input.siteAdmin === true ? " as site admin" : ""}${org ? `, ${orgRole} of org ${org.name}` : ""}`);
    owners.clear();
    return c.json({ account: await accountRowById(acct.id) }, 201);
  });

  // `siteAdmin`: grant or remove the role. `disabled`: true signs it out everywhere and blocks login, tokens and
  // its personal apps' deploy keys (its sites keep serving: delete them separately); false lets it sign in again.
  app.patch("/admin/accounts/:id", async (c) => {
    const who = requireSiteAdmin(c);
    const a = await getAccount(c.req.param("id"));
    const input = await body<{ siteAdmin?: unknown; disabled?: unknown } | null>(c) ?? {};
    if (input.siteAdmin !== undefined && typeof input.siteAdmin !== "boolean") throw new HttpError(400, "siteAdmin must be true or false");
    if (input.disabled !== undefined && typeof input.disabled !== "boolean") throw new HttpError(400, "disabled must be true or false");
    if (input.disabled === true) changeable(c, a, "disable");
    if (input.siteAdmin === false) changeable(c, a, "remove the site admin role from");
    await stillSiteAdmin(cfg, store, c);
    // Enabling first: it can be refused (409), and then nothing has changed.
    if (input.disabled === false && a.disabled_at) {
      if (await store.enableAccount(a.id) === "taken") {
        throw new HttpError(409, `another account now has ${a.disabled_email ?? a.email} or its GitHub login: change that one first`, "conflict");
      }
      console.log(`cresslet: ${a.disabled_email} enabled by ${who}`);
    }
    if (input.siteAdmin !== undefined) await setSiteAdmin(c, who, a, input.siteAdmin);
    if (input.disabled === true && await store.disableAccount(a.id)) {
      console.log(`cresslet: ${a.email} disabled by ${who}`);
    }
    owners.clear();
    return c.json({ account: await accountRowById(a.id) });
  });

  // Withdraws an invite: deletes an account that never signed in and owns nothing. Real accounts are disabled instead.
  app.delete("/admin/accounts/:id", async (c) => {
    const who = requireSiteAdmin(c);
    const a = await getAccount(c.req.param("id"));
    await stillSiteAdmin(cfg, store, c);
    const r = await store.deleteInvitedAccount(a.id);
    if (r === "last_admin") throw new HttpError(409, `${a.email} is an organization's only admin: make someone else its admin first`, "last_admin");
    if (r === "not_invited") {
      throw new HttpError(409, "only an invited account that hasn't signed in yet can be deleted: disable it instead", "not_invited");
    }
    console.log(`cresslet: invite for ${a.email} withdrawn by ${who}`);
    return c.json({ deleted: a.id });
  });

  // Grant / revoke the SiteAdmin role by email (older API; PATCH /admin/accounts/:id does the same).
  app.put("/admin/accounts/role", async (c) => {
    const who = requireSiteAdmin(c);
    const { email, role } = await body<{ email?: string; role?: string | null }>(c);
    if (role !== SITE_ADMIN && role !== null) throw new HttpError(400, `role must be "${SITE_ADMIN}" or null`);
    const acct = email ? await store.accountByEmail(email) : undefined;
    if (!acct) throw new HttpError(404, "account not found", "not_found");
    if (role === null && acct.id === c.get("account")?.id) throw new HttpError(400, "you can't remove your own role");
    await stillSiteAdmin(cfg, store, c);
    await setSiteAdmin(c, who, acct, role === SITE_ADMIN);
    return c.json({ account: { id: acct.id, email: acct.email, github: acct.github_login, role } });
  });

  // Give an account AI credits (negative: take some back). Needs AI credits on (CRESSLET_ANTHROPIC_API_KEY).
  app.post("/admin/accounts/credits", async (c) => {
    const who = requireSiteAdmin(c);
    if (!cfg.ai) throw new HttpError(409, "AI credits aren't enabled on this server (CRESSLET_ANTHROPIC_API_KEY)", "ai_disabled");
    const { email, credits, note } = await body<{ email?: unknown; credits?: unknown; note?: unknown } | null>(c) ?? {};
    if (typeof credits !== "number" || !Number.isFinite(credits) || Math.round(credits * 1000) === 0 || Math.abs(credits) > 10_000_000) {
      throw new HttpError(400, "credits must be a non-zero number, to a thousandth (at most 10,000,000 either way)");
    }
    if (note !== undefined && (typeof note !== "string" || note.length > 200)) throw new HttpError(400, "note must be a string of at most 200 characters");
    const acct = typeof email === "string" && email ? await store.accountByEmail(email) : undefined;
    if (!acct) throw new HttpError(404, "account not found", "not_found");
    await stillSiteAdmin(cfg, store, c); // again: access may have changed while the body arrived
    const balance = await store.grantAi(acct.id, Math.round(credits * 1000), { note: note ?? null, by: who });
    console.log(`cresslet: ${credits} AI credits to ${acct.email} by ${who}`);
    return c.json({ account: { id: acct.id, email: acct.email, github: acct.github_login }, balance: balance / 1000 });
  });

  // AI credit usage across accounts: this month's totals, per model and per day (last 30), every account with a
  // wallet, and the latest ledger rows. `{enabled: false}` without AI credits.
  const DAY = 86_400_000;
  const DAYS = 30;
  const walletView = (allowance: number, r: AiAccountRow) => ({
    balance: toCredits(r.balance),
    monthlyUsed: toCredits(r.period_used),
    available: toCredits(r.balance + Math.max(0, allowance - r.period_used)),
    used: toCredits(r.used),
    requests: r.requests,
    lastUsedAt: iso(r.last_used_at),
  });
  const acctRef = (a: { id: string; email: string; github_login: string | null }) => ({ id: a.id, email: a.email, github: a.github_login });

  app.get("/admin/credits", async (c) => {
    requireSiteAdmin(c);
    const ai = cfg.ai;
    if (!ai) return c.json({ enabled: false });
    const now = Date.now(), since = periodStart(now), allowance = Math.round(ai.monthlyCredits * 1000);
    const accounts = (await store.aiAccounts(period(now), since)).map((r) => ({ ...acctRef(r), ...walletView(allowance, r) }));
    const models = await store.aiModels(since);
    const today = Math.floor(now / DAY);
    const byDay = new Map((await store.aiDays((today - DAYS + 1) * DAY)).map((d) => [d.day, d]));
    const granted = await store.aiGranted(since), held = await store.aiOutstanding();
    const sum = (k: "used" | "requests" | "free" | "usd") => models.reduce((n, m) => n + m[k], 0);
    return c.json({
      enabled: true,
      creditsPerUsd: ai.creditsPerUsd,
      monthlyCredits: ai.monthlyCredits,
      period: period(now),
      resetsAt: nextPeriod(now),
      totals: {
        used: toCredits(sum("used")),
        free: toCredits(sum("free")),
        usd: Math.round(sum("usd") * 1e6) / 1e6,
        requests: sum("requests"),
        granted: toCredits(granted.amount),
        grants: granted.grants,
        balance: toCredits(held.balance),
        overdrawn: toCredits(held.overdrawn),
        accounts: accounts.length,
        active: accounts.filter((a) => a.requests > 0).length,
      },
      days: Array.from({ length: DAYS }, (_, i) => {
        const day = today - DAYS + 1 + i, d = byDay.get(day);
        return { date: new Date(day * DAY).toISOString().slice(0, 10), credits: toCredits(d?.used ?? 0), requests: d?.requests ?? 0 };
      }),
      models: models.map((m) => ({
        model: m.model ?? "unknown",
        credits: toCredits(m.used),
        requests: m.requests,
        usd: Math.round(m.usd * 1e6) / 1e6,
        inputTokens: m.input,
        outputTokens: m.output,
      })),
      accounts,
    });
  });

  // The credit ledger across accounts (or one: ?account=<id>), a page at a time, newest first (see ledgerPage).
  app.get("/admin/credits/activity", async (c) => {
    requireSiteAdmin(c);
    if (!cfg.ai) return c.json({ enabled: false });
    const id = c.req.query("account")?.trim() || null;
    if (id && !(await store.accountById(id))) throw new HttpError(404, "account not found", "not_found");
    const { limit, offset, upTo } = ledgerPage(c);
    const n = await store.aiLedgerCount(id, upTo);
    const top = upTo ?? n.last;
    return c.json({
      enabled: true,
      entries: (await store.aiLedgerAll(limit, offset, top, id))
        .map((r) => ({ ...ledgerEntry(r, { admin: true }), account: acctRef({ ...r, id: r.account_id }) })),
      total: n.count,
      upTo: top,
    });
  });

  // One account's wallet.
  app.get("/admin/credits/accounts/:id", async (c) => {
    requireSiteAdmin(c);
    const ai = cfg.ai;
    if (!ai) return c.json({ enabled: false });
    const acct = await store.accountById(c.req.param("id"));
    if (!acct) throw new HttpError(404, "account not found", "not_found");
    const now = Date.now(), allowance = Math.round(ai.monthlyCredits * 1000);
    const row = (await store.aiAccounts(period(now), periodStart(now), acct.id))[0] ??
      { ...acct, balance: 0, period_used: 0, used: 0, requests: 0, last_used_at: null };
    return c.json({
      enabled: true,
      monthlyCredits: ai.monthlyCredits,
      resetsAt: nextPeriod(now),
      account: { ...acctRef(acct), siteAdmin: isSiteAdmin(cfg, acct), ...walletView(allowance, row) },
    });
  });
}
