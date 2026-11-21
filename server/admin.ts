// Site admin API (/v1/admin): every site on the server, its disk and database usage, delete/restore/purge.
// Allowed for accounts with the SiteAdmin role (or listed in CRESSLET_SITE_ADMINS) and the operator's admin token.
import type { Context, Hono } from "hono";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { appUrl, type Config, paths } from "./config.ts";
import { type Account, type App, SITE_ADMIN, type Store, type Token } from "./store.ts";
import type { Runtime } from "./runtime.ts";
import { inspect } from "./inspect.ts";
import { HttpError, removeAppFiles } from "./deploys.ts";

type Env = { Bindings: { remoteAddr?: string }; Variables: { account?: Account; token?: Token; bearer?: string } };

export const isSiteAdmin = (cfg: Config, a: Account | undefined) =>
  !!a && (a.role === SITE_ADMIN || cfg.siteAdmins.includes(a.email) ||
    (!!a.github_login && cfg.siteAdmins.includes(a.github_login.toLowerCase())));

/** Permanently removes an app: process, rows (deploys, secrets, domains cascade), logs, files. */
export async function purgeApp(cfg: Config, store: Store, runtime: Runtime, a: App) {
  store.deleteApp(a.id); // first: no new request starts its sandbox
  try {
    await runtime.stopSettled(a.id);
  } finally {
    runtime.logs.drop(a.id);
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
    const acct = c.get("account"), t = c.get("token");
    // Only with a full-access token: a site admin's scoped token (read, deploy, some apps) doesn't count.
    if (isSiteAdmin(cfg, acct) && t?.role === "admin" && !t.apps) return acct!.github_login ?? acct!.email;
    if (isAdminToken(c.get("bearer"))) return "operator";
    throw new HttpError(acct ? 403 : 401, "site admin only", acct ? "forbidden" : "unauthorized");
  };

  const getSite = (name: string) => {
    const a = store.appByName(name, true);
    if (!a) throw new HttpError(404, `site not found: ${name}`, "not_found");
    return a;
  };

  const owners = new Map<string, Account | undefined>();
  const owner = (id: string | null) => {
    if (!id) return null;
    if (!owners.has(id)) owners.set(id, store.accountById(id));
    const o = owners.get(id);
    return o ? { id: o.id, email: o.email, github: o.github_login } : null;
  };

  const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
  const siteView = async (a: App) => {
    const config = JSON.parse(a.config) as { server?: boolean; crons?: string[] };
    const rt = runtime.status(a.id);
    const served = a.current_deploy_id ?? a.page_deploy_id;
    const deploy = served ? store.deploy(served) : undefined;
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      ...(a.kind === "page" ? { visibility: a.visibility } : {}),
      url: appUrl(cfg, a.name),
      status: a.deleted_at ? "deleted" : rt.running ? "running" : served ? "idle" : "empty",
      owner: owner(a.account_id),
      server: !!config.server,
      crons: config.crons?.length ?? 0,
      domains: store.domains(a.id).filter((d) => d.verified_at).map((d) => d.domain),
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
    const sites = await Promise.all(store.allApps().map(siteView));
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
    const a = getSite(c.req.param("name"));
    // Site admin powers cover the site, not its data: the tables are only shown to whoever runs the app
    // (its owner, or an admin it invited).
    let database: { tables: { name: string; rows: number }[]; error: string | null; truncated?: true } | null = null;
    // requireSiteAdmin already demands a full-access token (admin role, every app).
    const acct = c.get("account"), access = acct ? store.access(a, acct.id) : undefined;
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
      deploys: store.deploys(a.id, 10).map((d) => ({
        id: d.id,
        createdAt: iso(d.created_at),
        bytes: d.bytes,
        files: d.file_count,
        server: !!d.has_server,
        source: d.source,
        current: d.id === (a.current_deploy_id ?? a.page_deploy_id),
      })),
      domains: store.domains(a.id).map((d) => ({ domain: d.domain, verified: !!d.verified_at })),
      secrets: store.secretKeys(a.id).length,
      database,
      runtime: runtime.status(a.id),
    });
  });

  // Soft delete: offline right away (not served, no crons, owner sees 404), restorable until purged.
  // `?purge=1` deletes it permanently now.
  app.delete("/admin/sites/:name", async (c) => {
    const who = requireSiteAdmin(c);
    const a = getSite(c.req.param("name"));
    if (c.req.query("purge") === "1") {
      await purgeApp(cfg, store, runtime, a);
      console.log(`cresslet: site ${a.name} purged by ${who}`);
      return c.json({ purged: a.name });
    }
    if (!a.deleted_at) {
      runtime.stop(a.id);
      store.setDeleted(a.id, Date.now());
      runtime.logs.push(a.id, "system", `site deleted by site admin ${who}`);
    }
    return c.json({ site: await siteView(store.appById(a.id, true)!) });
  });

  app.post("/admin/sites/:name/restore", async (c) => {
    const who = requireSiteAdmin(c);
    const a = getSite(c.req.param("name"));
    if (a.deleted_at) {
      store.setDeleted(a.id, null);
      runtime.logs.push(a.id, "system", `site restored by site admin ${who}`);
    }
    return c.json({ site: await siteView(store.appById(a.id)!) });
  });

  // Grant / revoke the SiteAdmin role. Accounts listed in CRESSLET_SITE_ADMINS stay admins regardless.
  app.put("/admin/accounts/role", async (c) => {
    const who = requireSiteAdmin(c);
    const { email, role } = await body<{ email?: string; role?: string | null }>(c);
    if (role !== SITE_ADMIN && role !== null) throw new HttpError(400, `role must be "${SITE_ADMIN}" or null`);
    const acct = email ? store.accountByEmail(email) : undefined;
    if (!acct) throw new HttpError(404, "account not found", "not_found");
    if (role === null && acct.id === c.get("account")?.id) throw new HttpError(400, "you can't remove your own role");
    store.setRole(acct.id, role);
    console.log(`cresslet: ${acct.email} role ${role ?? "(none)"} set by ${who}`);
    return c.json({ account: { id: acct.id, email: acct.email, github: acct.github_login, role } });
  });

  // Give an account AI credits (negative: take some back). Needs AI credits on (CRESSLET_ANTHROPIC_API_KEY).
  app.post("/admin/accounts/credits", async (c) => {
    const who = requireSiteAdmin(c);
    if (!cfg.ai) throw new HttpError(409, "AI credits aren't enabled on this server (CRESSLET_ANTHROPIC_API_KEY)", "ai_disabled");
    const { email, credits, note } = await body<{ email?: string; credits?: number; note?: string }>(c);
    if (typeof credits !== "number" || !Number.isFinite(credits) || credits === 0 || Math.abs(credits) > 10_000_000) {
      throw new HttpError(400, "credits must be a non-zero number (at most 10,000,000 either way)");
    }
    if (note !== undefined && (typeof note !== "string" || note.length > 200)) throw new HttpError(400, "note must be a string of at most 200 characters");
    const acct = email ? store.accountByEmail(email) : undefined;
    if (!acct) throw new HttpError(404, "account not found", "not_found");
    const balance = store.grantAi(acct.id, Math.round(credits * 1000), { note: note ?? null, by: who });
    console.log(`cresslet: ${credits} AI credits to ${acct.email} by ${who}`);
    return c.json({ account: { id: acct.id, email: acct.email, github: acct.github_login }, balance: balance / 1000 });
  });
}
