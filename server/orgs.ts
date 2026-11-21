// Organizations (docs/api.md#organizations): site admins create them and pick their first admin; org admins add
// and remove members (accounts that already exist: only site admins invite new people to the server). An app in
// an organization belongs to it: org admins own it, members get admin access (Store.access).
import type { Context, Hono } from "hono";
import { appUrl, type Config } from "./config.ts";
import { type Env, siteAdminActor } from "./admin.ts";
import { HttpError } from "./deploys.ts";
import {
  type Account,
  type App,
  type Org,
  ORG_ROLES,
  orgLock,
  type OrgRole,
  type Role,
  type Store,
} from "./store.ts";

/** Slugs: like app names (1-40 of a-z, 0-9, single dashes inside). */
export const ORG_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,38}[a-z0-9]$|^[a-z0-9]$/;
const MAX_MEMBERS = 500;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);

export function orgRoutes(
  app: Hono<Env>,
  { cfg, store, isAdminToken, body, accountWide, checkQuota }: {
    cfg: Config;
    store: Store;
    isAdminToken: (bearer?: string) => boolean;
    body: <T>(c: Context<Env>) => Promise<T>;
    /** The request's account, if its token has `role` across the whole account. */
    accountWide: (c: Context<Env>, role: Role) => Account;
    /** Throws unless `acct` can have one more personal app (or artifact). */
    checkQuota: (acct: Account, kind: App["kind"]) => Promise<void>;
  },
) {
  const siteAdmin = (c: Context<Env>) => siteAdminActor(cfg, c, isAdminToken);
  const requireSiteAdmin = (c: Context<Env>) => {
    const actor = siteAdmin(c);
    if (actor) return actor;
    throw new HttpError(c.get("account") ? 403 : 401, "site admin only", c.get("account") ? "forbidden" : "unauthorized");
  };
  const getOrg = async (name: string) => {
    const o = await store.orgByName(name);
    if (!o) throw new HttpError(404, `organization not found: ${name}`, "not_found");
    return o;
  };
  const orgRole = (v: unknown): OrgRole => {
    if (!ORG_ROLES.includes(v as OrgRole)) throw new HttpError(400, `role must be one of ${ORG_ROLES.join(", ")}`);
    return v as OrgRole;
  };
  /**
   * Who may manage the organization's members: a site admin (full-access token, or the operator token), or one of
   * its admins with a full-access token. `who` for log lines; `site`: as site admin (exempt from the last-admin rule).
   */
  const manager = async (c: Context<Env>, o: Org) => {
    const sa = siteAdmin(c);
    if (sa) return { who: sa.who, id: sa.id, site: true };
    const acct = accountWide(c, "admin");
    if (await store.orgRole(o.id, acct.id) !== "admin") throw new HttpError(403, `only admins of ${o.name} can do that`, "forbidden");
    return { who: acct.github_login ?? acct.email, id: acct.id, site: false };
  };
  /** Again after the body arrived, under the org's lock: the caller may have been demoted or removed meanwhile. */
  const stillManages = async (c: Context<Env>, o: Org, m: { site: boolean; id: string | null }) => {
    if (m.site) return;
    const t = c.get("token")!;
    if (!(await store.tokens(m.id!)).some((x) => x.id === t.id)) throw new HttpError(401, "invalid token", "unauthorized");
    if (await store.orgRole(o.id, m.id!) !== "admin") throw new HttpError(403, `only admins of ${o.name} can do that`, "forbidden");
  };
  /** An organization must keep an enabled admin, unless a site admin changes it. */
  const keepAdmin = async (o: Org, accountId: string, site: boolean) => {
    if (site || await store.orgRole(o.id, accountId) !== "admin") return;
    const acct = await store.accountById(accountId);
    if (acct?.disabled_at) return; // doesn't count anyway
    if (await store.orgAdminCount(o.id) <= 1) {
      throw new HttpError(400, `${o.name} needs another admin first (an organization keeps at least one)`, "last_admin");
    }
  };

  const person = (p: { id: string; email: string; github_login: string | null }) => ({ id: p.id, email: p.email, github: p.github_login });
  const orgView = (o: Org) => ({ id: o.id, name: o.name, title: o.title, createdAt: iso(o.created_at) });

  // ---- for members
  app.get("/orgs", async (c) => {
    const acct = accountWide(c, "read");
    return c.json({ orgs: (await store.orgsFor(acct.id)).map((o) => ({ ...orgView(o), role: o.role })) });
  });

  // Members and apps: for its members and site admins (who manage it, but only see its apps' names).
  app.get("/orgs/:org", async (c) => {
    const o = await getOrg(c.req.param("org"));
    const sa = siteAdmin(c);
    const acct = sa ? c.get("account") : accountWide(c, "read");
    const role = acct ? await store.orgRole(o.id, acct.id) : undefined;
    if (!role && !sa) throw new HttpError(404, `organization not found: ${o.name}`, "not_found");
    return c.json({
      org: orgView(o),
      role: role ?? null,
      canManage: !!sa || role === "admin",
      members: (await store.orgMembers(o.id)).map((m) => ({
        ...person({ id: m.account_id, email: m.email, github_login: m.github_login }),
        role: m.role,
        disabled: !!m.disabled_at,
        createdAt: iso(m.created_at),
      })),
      apps: (await store.orgApps(o.id)).map((a) => ({ name: a.name, kind: a.kind, url: appUrl(cfg, a.name), updatedAt: iso(a.updated_at) })),
    });
  });

  // Add an existing account (by email) as admin or member. No account with that email: a site admin invites it.
  app.post("/orgs/:org/members", async (c) => {
    const o = await getOrg(c.req.param("org"));
    const m = await manager(c, o);
    const input = await body<{ email?: unknown; role?: unknown } | null>(c) ?? {};
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "valid email required");
    const role = orgRole(input.role ?? "member");
    const acct = await store.serialized(orgLock(o.id), async () => {
      await stillManages(c, o, m);
      const acct = await store.accountByEmail(email);
      if (!acct) {
        throw new HttpError(404, `no account has the email ${email}: a site admin can invite them to the server`, "no_account");
      }
      if (await store.orgRole(o.id, acct.id)) throw new HttpError(409, `${email} is already in ${o.name}: change their role instead`, "conflict");
      if ((await store.orgMembers(o.id)).length >= MAX_MEMBERS) throw new HttpError(400, `at most ${MAX_MEMBERS} members per organization`);
      await store.setOrgMember(o.id, acct.id, role);
      return acct;
    });
    console.log(`cresslet: ${acct.email} added to org ${o.name} as ${role} by ${m.who}`);
    return c.json({ member: { ...person(acct), role } }, 201);
  });

  app.put("/orgs/:org/members/:account", async (c) => {
    const o = await getOrg(c.req.param("org"));
    const m = await manager(c, o);
    const role = orgRole((await body<{ role?: unknown } | null>(c))?.role);
    const target = c.req.param("account");
    await store.serialized(orgLock(o.id), async () => {
      await stillManages(c, o, m);
      if (!await store.orgRole(o.id, target)) throw new HttpError(404, "member not found", "not_found");
      if (role !== "admin") await keepAdmin(o, target, m.site);
      await store.setOrgMember(o.id, target, role);
    });
    console.log(`cresslet: ${target} is now ${role} of org ${o.name}, set by ${m.who}`);
    return c.json({ account: target, role });
  });

  // Remove a member (org admins, site admins), or leave (any member, full-access token).
  app.delete("/orgs/:org/members/:account", async (c) => {
    const o = await getOrg(c.req.param("org"));
    const target = c.req.param("account");
    const me = c.get("account");
    const m = me && target === me.id && !siteAdmin(c)
      ? { who: me.github_login ?? me.email, id: accountWide(c, "admin").id, site: false, self: true }
      : { ...await manager(c, o), self: false };
    await store.serialized(orgLock(o.id), async () => {
      if (!m.self) await stillManages(c, o, m);
      if (!await store.orgRole(o.id, target)) throw new HttpError(404, "member not found", "not_found");
      await keepAdmin(o, target, m.site);
      await store.removeOrgMember(o.id, target);
      await store.reassignOrgApps(o.id, target);
    });
    console.log(`cresslet: ${target} ${m.self ? "left" : "removed from"} org ${o.name}${m.self ? "" : ` by ${m.who}`}`);
    return c.json({ removed: target });
  });

  // ---- for site admins
  app.get("/admin/orgs", async (c) => {
    requireSiteAdmin(c);
    return c.json({
      orgs: (await store.allOrgs()).map((o) => ({ ...orgView(o), members: o.members, apps: o.apps })),
    });
  });

  // `admin`: the email of an existing account to make its first admin.
  app.post("/admin/orgs", async (c) => {
    const sa = requireSiteAdmin(c);
    const input = await body<{ name?: unknown; title?: unknown; admin?: unknown } | null>(c) ?? {};
    const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
    if (!ORG_NAME_RE.test(name)) throw new HttpError(400, "name must be 1-40 chars of a-z, 0-9 and single dashes, not starting or ending with one", "invalid_name");
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : null;
    if (input.title != null && typeof input.title !== "string") throw new HttpError(400, "title must be a string");
    if (title && title.length > 100) throw new HttpError(400, "title must be at most 100 characters");
    let admin: Account | undefined;
    if (input.admin != null) {
      const email = typeof input.admin === "string" ? input.admin.trim().toLowerCase() : "";
      admin = email ? await store.accountByEmail(email) : undefined;
      if (!admin) throw new HttpError(404, `no account has the email ${email || String(input.admin)}: invite them first`, "no_account");
    }
    const o = await store.serialized("cresslet:create-org", async () => {
      if (await store.orgByName(name)) throw new HttpError(409, `an organization is already called ${name}`, "conflict");
      const o = await store.createOrg(name, title, sa.id);
      if (admin) await store.setOrgMember(o.id, admin.id, "admin");
      return o;
    });
    console.log(`cresslet: org ${o.name} created by ${sa.who}${admin ? `, admin ${admin.email}` : ""}`);
    return c.json({ org: orgView(o) }, 201);
  });

  // Only an empty one (no apps or artifacts, deleted ones included): its apps would go back to whoever last
  // held them. Move them out first.
  app.delete("/admin/orgs/:org", async (c) => {
    const sa = requireSiteAdmin(c);
    const o = await getOrg(c.req.param("org"));
    await store.serialized(orgLock(o.id), async () => {
      const n = await store.orgAppCount(o.id);
      if (n) throw new HttpError(409, `${o.name} still has ${n} app${n === 1 ? "" : "s"} or artifact${n === 1 ? "" : "s"}: move or delete them first`, "not_empty");
      await store.deleteOrg(o.id);
    });
    console.log(`cresslet: org ${o.name} deleted by ${sa.who}`);
    return c.json({ deleted: o.name });
  });

  // ---- moving an app (or artifact) into an organization, between them, or out (`org: null`)
  // Its owner does it (for an app in an organization: one of the org's admins), with a full-access token, and
  // must be a member of the organization it goes to. Out of one, it becomes the caller's personal app (quota
  // permitting). Collaborators and the deploy key stay as they are.
  app.put("/apps/:name/org", async (c) => {
    const acct = accountWide(c, "admin");
    const name = c.req.param("name");
    const getApp = async () => {
      const a = await store.appByName(name);
      if (!a) throw new HttpError(404, `app not found: ${name}`, "not_found");
      if (await store.access(a, acct.id) !== "owner") throw new HttpError(403, `only the owner of ${a.name} can move it`, "forbidden");
      return a;
    };
    await getApp();
    const input = await body<{ org?: unknown } | null>(c) ?? {};
    if (input.org !== null && typeof input.org !== "string") throw new HttpError(400, "org must be an organization's name, or null");
    const to = input.org === null ? null : await getOrg(input.org);
    // Under the app-creation lock: quotas can't race new apps; checked again there.
    const a = await store.serialized("cresslet:create-app", async () => {
      const a = await getApp();
      if (!(await store.tokens(acct.id)).some((x) => x.id === c.get("token")!.id)) throw new HttpError(401, "invalid token", "unauthorized");
      if ((a.org_id ?? null) === (to?.id ?? null)) return a;
      if (to && !await store.orgRole(to.id, acct.id)) throw new HttpError(403, `you're not a member of ${to.name}`, "forbidden");
      if (!to) await checkQuota(acct, a.kind);
      await store.setAppOrg(a.id, to?.id ?? null, acct.id);
      return (await store.appById(a.id))!;
    });
    console.log(`cresslet: ${a.name} moved to ${to ? `org ${to.name}` : `${acct.email}'s personal apps`} by ${acct.email}`);
    return c.json({ app: a.name, org: to ? { name: to.name, title: to.title } : null });
  });
}

/** `{name, title}` of each app's organization, for app views. */
export async function orgRefs(store: Store, apps: { org_id: string | null }[]) {
  const ids = [...new Set(apps.map((a) => a.org_id).filter((x): x is string => !!x))];
  const orgs = new Map<string, { name: string; title: string | null }>();
  for (const x of ids) {
    const o = await store.orgById(x);
    if (o) orgs.set(x, { name: o.name, title: o.title });
  }
  return (a: { org_id: string | null }) => (a.org_id ? orgs.get(a.org_id) ?? null : null);
}
