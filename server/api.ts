// Control-plane HTTP API (/v1). Used by cresslet-cli, the studio, and agents.
import { type Context, Hono, type Next } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  appUrl,
  type Config,
  MAX_RETENTION_DAYS,
  paths,
  previewAppName,
  previewOrigin,
  rootUrl,
  type Visibility,
  VISIBILITIES,
} from "./config.ts";
import { PAGE_TICKET_MS, PAGE_TICKET_PARAM } from "./host.ts";
import {
  type Access,
  ACCESS,
  type Account,
  type App,
  type AppAccess,
  type Domain,
  id,
  type Invite,
  type Role,
  ROLES,
  SITE_ADMIN,
  type Store,
  type Token,
} from "./store.ts";
import type { Runtime } from "./runtime.ts";
import { type Cluster, singleNode } from "./cluster.ts";
import { github } from "./github.ts";
import { cliLogin } from "./cli-login.ts";
import { confine } from "./bindings.ts";
import { normalizeEgress } from "./egress.ts";
import { adminRoutes, isSiteAdmin, purgeApp } from "./admin.ts";
import { RateLimit } from "./limits.ts";
import {
  type DeployFile,
  type DeployInput,
  HttpError,
  randomName,
  removeAppFiles,
  validName,
  writeDeploy,
  writePage,
} from "./deploys.ts";

export const VERSION = "0.1.0";
const TEMPLATES = join(import.meta.dirname, "../templates");
const encodeBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** `remoteAddr`: the TCP peer (main.ts passes it; tests don't). */
type Env = { Bindings: { remoteAddr?: string }; Variables: { account?: Account; token?: Token; bearer?: string; deploy?: unknown } };

export function api(cfg: Config, store: Store, runtime: Runtime, cluster: Cluster) {
  const app = new Hono<Env>().basePath("/v1");
  app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-cresslet-deploy-key"] }));

  // One app's calls run on the node that owns it (its files, sandbox, logs): forwarded unchanged,
  // before auth (the owner authorizes). Deleted sites too (admin restore/purge).
  const forward = async (appId: string, req: Request) => {
    const res = await cluster.forward(appId, req);
    return new Response(res.body, res); // mutable headers (CORS)
  };
  const toOwner = async (c: Context<Env>, next: Next) => {
    const a = c.req.method === "OPTIONS" ? undefined : store.appByName(c.req.param("name") ?? "", true);
    if (a && !cluster.local(a.id)) return forward(a.id, c.req.raw);
    await next();
  };
  app.use("/apps/:name/*", toOwner);
  app.use("/admin/sites/:name/*", toOwner);
  app.use("/pages/:name", toOwner);
  app.use("/pages/:name/*", toOwner);
  // A deploy names its app in the body: one for an app another node owns goes there as sent (bytes,
  // auth). A single node owns them all, so it doesn't read the body before auth.
  app.use("/deploys", async (c, next) => {
    if (cluster === singleNode || c.req.method !== "POST") return next();
    const bytes = await c.req.arrayBuffer().catch(() => undefined); // unreadable: the route answers 400
    let input: { app?: unknown } | null | undefined;
    try {
      if (bytes) input = JSON.parse(new TextDecoder().decode(bytes));
    } catch { /* the route answers 400 */ }
    c.set("deploy", input);
    const a = typeof input?.app === "string" ? store.appByName(input.app) : undefined;
    if (!a || cluster.local(a.id)) return next();
    return forwardDeploy(c, a.id);
  });
  /** The deploy request as sent (bytes cached by the middleware above). */
  const forwardDeploy = async (c: Context<Env>, appId: string) => {
    const { url, method, headers, signal } = c.req.raw;
    return forward(appId, new Request(url, { method, headers, body: await c.req.arrayBuffer(), signal }));
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal", message: "internal error" }, 500);
  });

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
    if (bearer) {
      c.set("bearer", bearer);
      if ((bearer.startsWith("clv_acct_") || bearer.startsWith("clv_scoped_")) && !isAdmin(bearer)) {
        const found = await store.useToken(bearer);
        if (!found) throw new HttpError(401, "invalid token", "unauthorized");
        c.set("account", found.account);
        c.set("token", found.token);
      }
    }
    await next();
  });

  const isAdmin = (bearer?: string) => {
    if (!cfg.adminToken || !bearer) return false;
    const a = Buffer.from(bearer), b = Buffer.from(cfg.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const deployKey = (c: Context<Env>) =>
    c.req.header("x-cresslet-deploy-key") ??
      (c.get("bearer")?.startsWith("clv_app_") ? c.get("bearer") : undefined);

  const atLeast = (t: Token, role: Role) => ROLES.indexOf(t.role) >= ROLES.indexOf(role);
  const tokenApps = (t: Token): string[] | null => t.apps ? JSON.parse(t.apps) : null;

  /** The request's account, if its token has `role` across the whole account (not limited to some apps). */
  function accountWide(c: Context<Env>, role: Role): Account {
    const acct = c.get("account"), t = c.get("token");
    if (!acct || !t) throw new HttpError(401, "login required", "unauthorized");
    if (!atLeast(t, role) || tokenApps(t)) {
      throw new HttpError(403, `this token can't do that (needs ${role} access to the whole account)`, "forbidden");
    }
    return acct;
  }

  /**
   * The app's owner or a collaborator, with a token allowing `role` on it, or the app's deploy key (full
   * access to that app). Viewers get `read`, admins everything but `owner` actions. `account`: no deploy key.
   * Returns the account's access (undefined when the deploy key let the request in).
   */
  async function authorize(
    c: Context<Env>,
    a: App,
    role: Role,
    opts: { owner?: boolean; account?: boolean } = {},
  ): Promise<AppAccess | undefined> {
    const acct = c.get("account"), t = c.get("token");
    let scopeError: string | undefined;
    const access = acct && t ? store.access(a, acct.id) : undefined;
    if (access) {
      const apps = tokenApps(t!);
      if (apps && !apps.includes(a.id)) scopeError = `this token is not scoped to app ${a.name}`;
      else if (!atLeast(t!, role)) scopeError = `this token can't do that (needs ${role} access, has ${t!.role})`;
      else if (opts.owner && access !== "owner") scopeError = `only the owner of ${a.name} can do that`;
      else if (access === "viewer" && role !== "read") scopeError = `viewers of ${a.name} can't do that (ask one of its admins)`;
      else return access;
    }
    if (opts.account && !acct) throw new HttpError(401, "login required (a deploy key can't do this)", "unauthorized");
    const key = opts.account ? undefined : deployKey(c);
    if (key && await store.checkDeployKey(a.id, key)) return;
    throw new HttpError(a.account_id || key || acct ? 403 : 401, scopeError ?? `not authorized for app ${a.name}`, "forbidden");
  }

  function getApp(name: string): App {
    const a = store.appByName(name);
    if (!a) throw new HttpError(404, `app not found: ${name}`, "not_found");
    return a;
  }
  /** App-only features (deploys, rollback, secrets, egress, domains): a page is static files. */
  function notPage(a: App) {
    if (a.kind === "page") throw new HttpError(409, `${a.name} is a page: change it with /v1/pages/${a.name}`, "is_page");
  }

  const accountView = (a: Account) => ({
    id: a.id,
    email: a.email,
    github: a.github_login,
    role: isSiteAdmin(cfg, a) ? SITE_ADMIN : null,
  });
  const iso = (ms: number | null) => ms ? new Date(ms).toISOString() : null;
  const tokenView = (t: Token, current?: Token) => {
    const ids = tokenApps(t);
    return {
      id: t.id,
      name: t.name,
      role: t.role,
      // Names of the apps it's limited to (deleted apps drop out), or null = every app.
      apps: ids ? ids.map((x) => store.appById(x)?.name).filter((n): n is string => !!n) : null,
      createdAt: iso(t.created_at),
      lastUsedAt: iso(t.last_used_at),
      ...(current ? { current: t.id === current.id } : {}),
    };
  };

  const view = (a: App) => ({
    id: a.id,
    name: a.name,
    url: appUrl(cfg, a.name),
    claimed: !!a.account_id,
    expiresAt: a.expires_at ? new Date(a.expires_at).toISOString() : null,
    currentDeployId: a.current_deploy_id,
    config: JSON.parse(a.config),
    egress: a.egress ? JSON.parse(a.egress) : null,
    createdAt: new Date(a.created_at).toISOString(),
    updatedAt: new Date(a.updated_at).toISOString(),
  });

  // ---- abuse limits (docs/self-hosting.md#configuration)
  const HOUR = 3600_000;
  const anonApps = new RateLimit(cfg.limits.anonAppsPerHour, HOUR);
  const appDeploys = new RateLimit(cfg.limits.deploysPerHour, HOUR);
  const clientIp = (c: Context<Env>) =>
    (cfg.clientIpHeader && c.req.header(cfg.clientIpHeader)?.split(",")[0].trim()) || c.env?.remoteAddr || "unknown";
  /** A new app (or a claimed one) for `acct` must fit its app quota. */
  const checkAppQuota = (acct: Account) => {
    if (isSiteAdmin(cfg, acct)) return;
    if (store.appsByAccount(acct.id).length >= cfg.limits.maxAppsPerAccount) {
      throw new HttpError(403, `app limit reached (${cfg.limits.maxAppsPerAccount} per account): delete one first`, "quota");
    }
  };

  const body = async <T>(c: Context<Env>): Promise<T> => {
    try {
      return await c.req.json<T>();
    } catch {
      throw new HttpError(400, "invalid JSON body", "bad_request");
    }
  };

  // ---- meta
  app.get("/", (c) =>
    c.json({
      name: "cresslet",
      version: VERSION,
      url: rootUrl(cfg),
      appUrlTemplate: appUrl(cfg, "{name}"),
      previewOrigin: previewOrigin(cfg),
      openSignup: cfg.openSignup,
      anonDeploys: cfg.anonDeploys,
      customDomains: cfg.customDomains,
      auth: { github: !!cfg.github, cli: !!cfg.github }, // cli: browser login via the studio, which logs in with GitHub
      limits: cfg.limits,
      docs: "https://github.com/ODumpling/cresslet/blob/main/docs/api.md",
    }));

  // ---- accounts (users log in with GitHub; this is the operator's escape hatch)
  // Admin-only: pre-create an account (a later GitHub login with the same verified email links to it)
  // or issue a token for it.
  app.post("/accounts", async (c) => {
    if (!isAdmin(c.get("bearer"))) throw new HttpError(403, "log in with GitHub", "forbidden");
    const { email } = await body<{ email?: string }>(c);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "valid email required");
    const account = store.accountByEmail(email) ?? store.createAccount(email);
    const { token } = await store.issueToken(account.id, { name: "Operator-issued" });
    return c.json({ account: accountView(account), token }, 201);
  });

  // Any valid token, whatever its scope (the CLI's `login --token` checks a token with this).
  app.get("/me", (c) => {
    const a = c.get("account"), t = c.get("token");
    if (!a || !t) throw new HttpError(401, "login required", "unauthorized");
    return c.json({ account: accountView(a), tokenInfo: tokenView(t) });
  });

  // Revoke every token for this account (studio, CLI, CI) and issue a fresh full-access one.
  app.post("/me/token", async (c) => {
    const a = accountWide(c, "admin");
    store.revokeTokens(a.id);
    const { token } = await store.issueToken(a.id, { name: c.get("token")!.name });
    return c.json({ account: accountView(a), token });
  });

  // ---- named / scoped tokens (managed with a full-access token)
  app.get("/me/tokens", (c) => {
    const a = accountWide(c, "admin");
    return c.json({ tokens: store.tokens(a.id).map((t) => tokenView(t, c.get("token"))) });
  });

  app.post("/me/tokens", async (c) => {
    const a = accountWide(c, "admin");
    const input = await body<{ name?: unknown; role?: unknown; apps?: unknown } | null>(c) ?? {};
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 64) throw new HttpError(400, "name required (at most 64 characters)");
    const role = input.role ?? "admin";
    if (!ROLES.includes(role as Role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
    let apps: string[] | null = null;
    if (input.apps != null) {
      if (!Array.isArray(input.apps) || !input.apps.length || input.apps.length > 50) {
        throw new HttpError(400, "apps must be a list of 1-50 app names, or null for every app");
      }
      apps = [...new Set(input.apps.map((n) => {
        const app = typeof n === "string" ? store.appByName(n) : undefined;
        if (!app || !store.access(app, a.id)) throw new HttpError(400, `not one of your apps: ${String(n)}`);
        return app.id;
      }))];
    }
    const { token, info } = await store.issueToken(a.id, { name, role: role as Role, apps });
    // The issuing token may have been revoked while this request was in flight (e.g. a slow body).
    if (!store.tokens(a.id).some((t) => t.id === c.get("token")!.id)) {
      store.revokeToken(a.id, info.id);
      throw new HttpError(401, "invalid token", "unauthorized");
    }
    return c.json({ token, info: tokenView(info) }, 201);
  });

  app.delete("/me/tokens/:id", (c) => {
    const a = accountWide(c, "admin");
    if (!store.revokeToken(a.id, c.req.param("id"))) throw new HttpError(404, "token not found", "not_found");
    return c.json({ revoked: c.req.param("id") });
  });

  // ---- GitHub login (see server/github.ts)
  if (cfg.github) {
    const gh = github(cfg, store);
    const redirectUri = gh.callbackUrl(rootUrl(cfg));
    const STATE_COOKIE = "cresslet_oauth_state";
    const studio = (hash: Record<string, string>) => `${rootUrl(cfg)}/#${new URLSearchParams(hash)}`;

    // Studio: browser navigates here, comes back to /#cresslet_login=<one-time code>.
    app.get("/auth/github", (c) => {
      const { state, url } = gh.authorize(redirectUri);
      setCookie(c, STATE_COOKIE, state, {
        path: "/v1/auth/github",
        httpOnly: true,
        sameSite: "Lax",
        secure: cfg.scheme === "https",
        maxAge: 600,
      });
      return c.redirect(url);
    });

    app.get("/auth/github/callback", async (c) => {
      const { code, state, error, error_description } = c.req.query();
      const cookie = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: "/v1/auth/github" });
      try {
        if (error) throw new HttpError(400, error_description ?? error);
        // State must match the browser that started the flow (prevents login CSRF).
        if (!code || !state || state !== cookie) throw new HttpError(400, "login expired, try again");
        return c.redirect(studio({ cresslet_login: await gh.callback(code, state, redirectUri) }));
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(err);
        return c.redirect(studio({ cresslet_login_error: err instanceof HttpError ? err.message : "GitHub login failed" }));
      }
    });

    app.post("/auth/exchange", async (c) => {
      const { code } = await body<{ code?: string }>(c);
      const l = gh.exchange(String(code ?? ""));
      return c.json({ account: accountView(l.account), token: l.token });
    });

    // CLI: device flow, proxied so the client secret never leaves the server.
    app.post("/auth/github/device", async (c) => c.json(await gh.deviceStart()));

    app.post("/auth/github/device/token", async (c) => {
      const { deviceCode } = await body<{ deviceCode?: string }>(c);
      if (!deviceCode) throw new HttpError(400, "deviceCode required");
      const r = await gh.devicePoll(deviceCode);
      if ("token" in r) return c.json({ status: "complete", account: accountView(r.account), token: r.token });
      return c.json(r);
    });

    // CLI browser login (server/cli-login.ts): start → studio approves at verificationUri → poll for the token.
    const cli = cliLogin(store);
    const cliStarts = new RateLimit(20, 10 * 60_000);
    const cliApproves = new RateLimit(10, 10 * 60_000);
    app.post("/auth/cli", (c) => {
      if (!cliStarts.take(clientIp(c))) throw new HttpError(429, "too many logins, try again in a few minutes", "rate_limited");
      return c.json(cli.start(rootUrl(cfg)));
    });

    app.post("/auth/cli/approve", async (c) => {
      const a = accountWide(c, "admin");
      // Guessing someone else's pending code would log their CLI in to this account.
      if (!cliApproves.take(a.id)) throw new HttpError(429, "too many tries, wait a few minutes", "rate_limited");
      const { userCode } = await body<{ userCode?: unknown } | null>(c) ?? {};
      if (typeof userCode !== "string" || !userCode) throw new HttpError(400, "userCode required");
      cli.approve(userCode, a, c.get("token")!.id);
      return c.json({ approved: true });
    });

    app.post("/auth/cli/token", async (c) => {
      const { deviceCode } = await body<{ deviceCode?: unknown } | null>(c) ?? {};
      if (typeof deviceCode !== "string" || !deviceCode) throw new HttpError(400, "deviceCode required");
      const r = await cli.poll(deviceCode);
      if ("token" in r) return c.json({ status: "complete", account: accountView(r.account), token: r.token });
      return c.json(r);
    });
  }

  // ---- templates
  app.get("/templates", async (c) => {
    const out = [];
    for (const e of await readdir(TEMPLATES, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      let meta = {};
      try {
        meta = JSON.parse(await readFile(join(TEMPLATES, e.name, "template.json"), "utf8"));
      } catch { /* optional */ }
      out.push({ name: e.name, ...meta });
    }
    return c.json({ templates: out.sort((a, b) => a.name.localeCompare(b.name)) });
  });

  app.get("/templates/:name", async (c) => {
    const name = c.req.param("name");
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(join(TEMPLATES, name))) {
      throw new HttpError(404, `template not found: ${name}`, "not_found");
    }
    const root = join(TEMPLATES, name);
    const files: { path: string; data: string; encoding: "utf8" | "base64" }[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name !== "template.json") {
          const bytes = await readFile(full);
          try {
            files.push({
              path: relative(root, full),
              data: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
              encoding: "utf8",
            });
          } catch {
            files.push({ path: relative(root, full), data: encodeBase64(bytes), encoding: "base64" });
          }
        }
      }
    };
    await walk(root);
    return c.json({ name, files: files.sort((a, b) => a.path.localeCompare(b.path)) });
  });

  // ---- deploys
  app.post("/deploys", async (c) => {
    const input = (c.get("deploy") ?? await body(c)) as DeployInput & { app?: string };
    const acct = c.get("account");
    let target = input.app ? store.appByName(input.app) : undefined;
    if (target && !cluster.local(target.id)) return forwardDeploy(c, target.id); // created on another node meanwhile
    let createdKey: string | undefined;
    if (target) {
      notPage(target);
      await authorize(c, target, "deploy");
      if (!appDeploys.take(target.id)) {
        throw new HttpError(429, `too many deploys of ${target.name} (${cfg.limits.deploysPerHour} per hour): try later`, "rate_limited");
      }
    } else {
      // A new app comes with a deploy key (full control of it): account-wide admin only.
      if (acct) accountWide(c, "admin");
      if (!acct && !cfg.anonDeploys) {
        throw new HttpError(401, "login required to deploy here (cresslet login, or set CRESSLET_TOKEN)", "unauthorized");
      }
      const name = input.app ?? uniqueName();
      if (store.appByName(name, true)) throw new HttpError(409, `app name unavailable: ${name}`, "conflict");
      if (!validName(name, cfg)) {
        throw new HttpError(400, "app name must be 1-40 chars of a-z, 0-9 and single dashes", "invalid_name");
      }
      const anonCap = () => {
        if (store.anonAppCount() >= cfg.limits.maxAnonApps) {
          throw new HttpError(429, "too many anonymous apps on this server right now: log in to deploy (cresslet login)", "rate_limited");
        }
      };
      if (acct) checkAppQuota(acct);
      else {
        anonCap();
        if (!anonApps.take(clientIp(c))) {
          throw new HttpError(429, `too many new anonymous apps from your address (${cfg.limits.anonAppsPerHour} per hour): log in, or try later`, "rate_limited");
        }
      }
      const expires = acct ? null : Date.now() + cfg.limits.anonTtlMs;
      // Checked again just before the insert: concurrent deploys can't share the last slot.
      const created = await store.createApp(name, expires, acct?.id ?? null, () => acct ? checkAppQuota(acct) : anonCap());
      target = created.app;
      createdKey = created.deployKey;
      appDeploys.take(target.id);
    }
    let deploy;
    try {
      deploy = await writeDeploy(cfg, store, target, input);
    } catch (e) {
      if (createdKey) {
        store.deleteApp(target.id);
        await removeAppFiles(cfg, target.id);
      }
      throw e;
    }
    runtime.stop(target.id); // next request boots the new version
    runtime.logs.push(target.id, "system", `deployed ${deploy.id} (${deploy.files} files${deploy.server ? ", server" : ""})`);
    return c.json({
      app: view(store.appById(target.id)!),
      deploy,
      ...(createdKey ? { deployKey: createdKey } : {}),
    }, 201);
  });

  function uniqueName() {
    for (let i = 0; i < 20; i++) {
      const n = randomName();
      if (!store.appByName(n, true)) return n;
    }
    throw new HttpError(500, "could not allocate name");
  }

  // ---- apps
  app.get("/apps", (c) => {
    const a = c.get("account"), t = c.get("token");
    if (!a || !t) throw new HttpError(401, "login required", "unauthorized");
    const only = tokenApps(t);
    // Owned and shared apps; `access`: owner, admin or viewer.
    return c.json({
      apps: store.appsFor(a.id).filter((x) => !only || only.includes(x.id)).map((x) => ({ ...view(x), access: x.access })),
    });
  });

  app.get("/apps/:name", async (c) => {
    const a = getApp(c.req.param("name"));
    const access = await authorize(c, a, "read");
    return c.json({
      app: { ...view(a), access: access ?? null },
      deploys: store.deploys(a.id, 10).map((d) => ({
        id: d.id,
        createdAt: new Date(d.created_at).toISOString(),
        bytes: d.bytes,
        files: d.file_count,
        server: !!d.has_server,
        source: d.source,
        current: d.id === a.current_deploy_id,
      })),
      runtime: runtime.status(a.id),
      secrets: store.secretKeys(a.id),
    });
  });

  app.delete("/apps/:name", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a, "admin", { owner: true });
    await purgeApp(cfg, store, runtime, a);
    return c.json({ deleted: a.name });
  });

  app.post("/apps/:name/claim", async (c) => {
    if (!c.get("account")) throw new HttpError(401, "login required (cresslet login)", "unauthorized");
    const acct = accountWide(c, "admin");
    const a = getApp(c.req.param("name"));
    const { deployKey: k } = await body<{ deployKey?: string }>(c).catch(() => ({ deployKey: undefined }));
    const key = k ?? c.req.header("x-cresslet-deploy-key");
    if (a.account_id === acct.id) return c.json({ app: view(a) });
    if (a.account_id) throw new HttpError(409, "app already claimed", "conflict");
    if (!key || !await store.checkDeployKey(a.id, key)) throw new HttpError(403, "deploy key required", "forbidden");
    checkAppQuota(acct);
    store.claimApp(a.id, acct.id);
    runtime.stop(a.id); // restart with network access
    return c.json({ app: view(store.appById(a.id)!) });
  });

  app.post("/apps/:name/rollback", async (c) => {
    const a = getApp(c.req.param("name"));
    notPage(a);
    await authorize(c, a, "deploy");
    const { deployId } = await body<{ deployId?: string }>(c);
    await authorize(c, a, "deploy"); // again: access may have changed while the body arrived (a collaborator removed)
    const d = deployId ? store.deploy(deployId) : store.deploys(a.id, 2)[1];
    if (!d || d.app_id !== a.id) throw new HttpError(404, "deploy not found", "not_found");
    const config = JSON.parse(await readFile(join(paths(cfg, a.id).deploy(d.id), "deploy.json"), "utf8"));
    store.setCurrentDeploy(a.id, d.id, config);
    runtime.stop(a.id);
    runtime.logs.push(a.id, "system", `rolled back to ${d.id}`);
    return c.json({ app: view(store.appById(a.id)!) });
  });

  // ---- collaborators: accounts invited to an app as admin or viewer (see docs/api.md)
  const MAX_COLLABORATORS = 50; // collaborators + pending invites, per app
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const person = (p: { id: string; email: string; github_login: string | null }) =>
    ({ id: p.id, email: p.email, github: p.github_login });
  const inviteView = (i: Invite) => {
    const by = i.invited_by ? store.accountById(i.invited_by) : undefined;
    return { id: i.id, email: i.email, role: i.role, invitedBy: by ? person(by) : null, createdAt: iso(i.created_at) };
  };
  const accessRole = (v: unknown): Access => {
    if (!ACCESS.includes(v as Access)) throw new HttpError(400, `role must be one of ${ACCESS.join(", ")}`);
    return v as Access;
  };
  /** Managing who has access: the owner or an admin, logged in (a deploy key isn't an account). */
  const manage = async (c: Context<Env>) => {
    const a = getApp(c.req.param("name")!);
    await authorize(c, a, "admin", { account: true });
    return a;
  };
  /**
   * Checks again after reading the body, right before granting access: the caller may have been demoted or
   * removed, or its token revoked, while the request was in flight (else a demoted admin could re-promote).
   */
  const stillManages = async (c: Context<Env>, a: App) => {
    const acct = c.get("account")!;
    if (!store.tokens(acct.id).some((t) => t.id === c.get("token")!.id)) throw new HttpError(401, "invalid token", "unauthorized");
    await authorize(c, a, "admin", { account: true });
  };

  app.get("/apps/:name/collaborators", async (c) => {
    const a = await manage(c);
    const owner = store.accountById(a.account_id!)!;
    return c.json({
      owner: person(owner),
      collaborators: store.collaborators(a.id).map((x) =>
        ({ ...person({ id: x.account_id, email: x.email, github_login: x.github_login }), role: x.role, createdAt: iso(x.created_at) })),
      invites: store.invites(a.id).map(inviteView),
    });
  });

  // Invite by email: the account with that email accepts it (GET /v1/me/invites). No email is sent, and
  // the response is the same whether or not such an account exists yet.
  app.post("/apps/:name/collaborators", async (c) => {
    const a = await manage(c);
    const input = await body<{ email?: unknown; role?: unknown } | null>(c) ?? {};
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "valid email required");
    const role = accessRole(input.role ?? "viewer");
    await stillManages(c, a);
    const invitee = store.accountByEmail(email);
    if (invitee && invitee.id === a.account_id) throw new HttpError(400, `${email} owns ${a.name}`);
    if (invitee && store.access(a, invitee.id)) {
      throw new HttpError(409, `${email} already has access: change their role instead`, "conflict");
    }
    const invites = store.invites(a.id);
    if (!invites.some((i) => i.email === email) && invites.length + store.collaborators(a.id).length >= MAX_COLLABORATORS) {
      throw new HttpError(400, `at most ${MAX_COLLABORATORS} collaborators and invites per app`);
    }
    const r = store.invite(a.id, email, role, c.get("account")!.id);
    return c.json({ invite: inviteView(r.invite) }, r.created ? 201 : 200);
  });

  app.put("/apps/:name/collaborators/:account", async (c) => {
    const a = await manage(c);
    const role = accessRole((await body<{ role?: unknown } | null>(c))?.role);
    await stillManages(c, a);
    if (!store.setCollaboratorRole(a.id, c.req.param("account"), role)) {
      throw new HttpError(404, "collaborator not found", "not_found");
    }
    return c.json({ account: c.req.param("account"), role });
  });

  // Remove a collaborator (owner or admin), or leave an app you were invited to (any role, admin token).
  app.delete("/apps/:name/collaborators/:account", async (c) => {
    const target = c.req.param("account");
    const me = c.get("account"), t = c.get("token");
    if (me && t && target === me.id) {
      const a = getApp(c.req.param("name"));
      const access = store.access(a, me.id), apps = tokenApps(t);
      if (!access) throw new HttpError(404, "collaborator not found", "not_found");
      if (access === "owner") throw new HttpError(400, "the owner can't leave their own app");
      if ((apps && !apps.includes(a.id)) || !atLeast(t, "admin")) {
        throw new HttpError(403, `this token can't do that (needs admin access to ${a.name})`, "forbidden");
      }
      store.removeCollaborator(a.id, me.id);
      return c.json({ removed: me.id });
    }
    const a = await manage(c);
    if (!store.removeCollaborator(a.id, target)) throw new HttpError(404, "collaborator not found", "not_found");
    return c.json({ removed: target });
  });

  app.delete("/apps/:name/invites/:id", async (c) => {
    const a = await manage(c);
    if (!store.cancelInvite(a.id, c.req.param("id"))) throw new HttpError(404, "invite not found", "not_found");
    return c.json({ cancelled: c.req.param("id") });
  });

  // ---- invites to the calling account (matched by its email)
  app.get("/me/invites", (c) => {
    const acct = accountWide(c, "read");
    return c.json({
      invites: store.invitesFor(acct.email).map((i) => ({ ...inviteView(i), app: i.app_name })),
    });
  });

  const myInvite = (c: Context<Env>) => {
    const acct = accountWide(c, "admin");
    const inv = store.inviteFor(acct.email, c.req.param("id")!);
    const a = inv && store.appById(inv.app_id);
    if (!inv || !a) throw new HttpError(404, "invite not found", "not_found");
    return { acct, inv, a };
  };

  app.post("/me/invites/:id/accept", (c) => {
    const { acct, inv, a } = myInvite(c);
    store.acceptInvite(inv, acct.id);
    return c.json({ app: { ...view(a), access: store.access(a, acct.id) ?? null } });
  });

  app.delete("/me/invites/:id", (c) => {
    const { inv } = myInvite(c);
    store.declineInvite(inv.id);
    return c.json({ declined: inv.id });
  });

  // ---- project source uploaded with a deploy (cresslet pull / studio "Open")
  app.get("/apps/:name/source", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a, "read");
    const deployId = c.req.query("deploy") ?? a.current_deploy_id;
    const d = deployId ? store.deploy(deployId) : undefined;
    if (!d || d.app_id !== a.id) throw new HttpError(404, "deploy not found", "not_found");
    const root = join(paths(cfg, a.id).deploy(d.id), "source");
    if (!existsSync(root)) throw new HttpError(404, "this deploy has no source (deployed without it)", "no_source");
    const files: { path: string; data: string; encoding: "utf8" | "base64" }[] = [];
    for (const rel of (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())) {
      const abs = join(rel.parentPath, rel.name);
      const bytes = await readFile(abs);
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let data: string, encoding: "utf8" | "base64" = "utf8";
      try {
        data = text.decode(bytes);
      } catch {
        data = encodeBase64(bytes);
        encoding = "base64";
      }
      files.push({ path: relative(root, abs).split("\\").join("/"), data, encoding });
    }
    files.sort((x, y) => x.path.localeCompare(y.path));
    c.header("cache-control", "no-store"); // private project source
    return c.json({ app: a.name, deployId: d.id, files });
  });

  // ---- logs (NDJSON; ?follow=1 streams)
  app.get("/apps/:name/logs", async (c) => {
    const a = getApp(c.req.param("name"));
    const access = await authorize(c, a, "read");
    const n = Math.min(Number(c.req.query("n") ?? 200), cfg.limits.logLines);
    // A collaborator's stream ends when they lose access (removed, or left): checked per line and every 15s.
    const acct = c.get("account");
    const collaborator = access === "admin" || access === "viewer";
    const revoked = () => collaborator && !store.access(a, acct!.id);
    const follow = c.req.query("follow") === "1";
    const enc = new TextEncoder();
    const line = (l: unknown) => enc.encode(JSON.stringify(l) + "\n");
    let unsub = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const l of runtime.logs.recent(a.id, n)) ctrl.enqueue(line(l));
        if (!follow) return ctrl.close();
        const end = () => {
          unsub();
          ctrl.close();
        };
        const sub = runtime.logs.subscribe(a.id, (l) => (revoked() ? end() : ctrl.enqueue(line(l))));
        const timer = collaborator ? setInterval(() => revoked() && end(), 15_000) : undefined;
        timer?.unref();
        unsub = () => {
          sub();
          clearInterval(timer);
          unsub = () => {};
        };
      },
      cancel() {
        unsub();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
  });

  // ---- secrets (claimed apps only; values are write-only)
  app.get("/apps/:name/secrets", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a, "read");
    return c.json({ keys: store.secretKeys(a.id) });
  });

  app.put("/apps/:name/secrets", async (c) => {
    const a = getApp(c.req.param("name"));
    notPage(a);
    await authorize(c, a, "admin");
    if (!a.account_id) throw new HttpError(403, "secrets require a claimed app (cresslet claim)", "unclaimed");
    const input = await body<Record<string, string | null>>(c);
    await authorize(c, a, "admin"); // again: access may have changed while the body arrived (a collaborator removed)
    for (const [k, v] of Object.entries(input)) {
      if (!SECRET_KEY_RE.test(k)) throw new HttpError(400, `invalid secret name: ${k} (use UPPER_SNAKE)`);
      if (v === null) store.deleteSecret(a.id, k);
      else if (typeof v === "string" && v.length <= 32_768) store.setSecret(a.id, k, v);
      else throw new HttpError(400, `invalid value for ${k}`);
    }
    runtime.stop(a.id);
    return c.json({ keys: store.secretKeys(a.id) });
  });

  app.delete("/apps/:name/secrets/:key", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a, "admin");
    store.deleteSecret(a.id, c.req.param("key"));
    runtime.stop(a.id);
    return c.json({ keys: store.secretKeys(a.id) });
  });

  // ---- egress allowlist (claimed apps; null = any public host)
  app.get("/apps/:name/egress", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a, "read");
    return c.json({ allow: a.egress ? JSON.parse(a.egress) : null });
  });

  app.put("/apps/:name/egress", async (c) => {
    const a = getApp(c.req.param("name"));
    notPage(a);
    await authorize(c, a, "admin");
    if (!a.account_id) throw new HttpError(403, "outbound network requires a claimed app (cresslet claim)", "unclaimed");
    const { allow } = await body<{ allow?: unknown }>(c);
    await authorize(c, a, "admin"); // again: access may have changed while the body arrived (a collaborator removed)
    let list: string[] | null = null;
    if (allow !== null) {
      try {
        list = normalizeEgress(allow);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    store.setEgress(a.id, list);
    runtime.stop(a.id);
    runtime.logs.push(a.id, "system", list ? `egress allowlist: ${list.join(", ") || "(none)"}` : "egress: any public host");
    return c.json({ allow: list });
  });

  // ---- custom domains (claimed apps). Ownership proof: TXT _cresslet.<domain> = token.
  const MAX_DOMAINS = 10;
  const domainView = (a: App, d: Domain) => ({
    domain: d.domain,
    verified: !!d.verified_at,
    dns: [
      { type: "CNAME", name: d.domain, value: new URL(appUrl(cfg, a.name)).hostname },
      { type: "TXT", name: `_cresslet.${d.domain}`, value: d.token },
    ],
  });
  const claimed = async (c: Context<Env>, role: Role) => {
    const a = getApp(c.req.param("name")!);
    notPage(a);
    await authorize(c, a, role);
    if (!a.account_id) throw new HttpError(403, "custom domains require a claimed app (cresslet claim)", "unclaimed");
    return a;
  };
  /** Adding and verifying need the server to route and certify the hostname (`CRESSLET_CUSTOM_DOMAINS`). */
  const domainsEnabled = (a: App) => {
    if (!cfg.customDomains) {
      throw new HttpError(403, `custom domains are turned off on this server: use ${appUrl(cfg, a.name)}`, "custom_domains_disabled");
    }
  };

  app.get("/apps/:name/domains", async (c) => {
    const a = await claimed(c, "read");
    return c.json({ domains: store.domains(a.id).map((d) => domainView(a, d)) });
  });

  app.post("/apps/:name/domains", async (c) => {
    const a = await claimed(c, "admin");
    domainsEnabled(a);
    const raw = (await body<{ domain?: unknown } | null>(c))?.domain;
    await authorize(c, a, "admin"); // again: access may have changed while the body arrived (a collaborator removed)
    const domain = typeof raw === "string" ? normDomain(raw) : "";
    if (!validDomain(domain) || domain === cfg.domain || domain.endsWith("." + cfg.domain) || domain === cfg.previewHost) {
      throw new HttpError(400, `invalid domain: ${String(raw)}`);
    }
    const existing = store.domains(a.id).find((d) => d.domain === domain);
    if (existing) return c.json({ domain: domainView(a, existing) });
    if (store.domains(a.id).length >= MAX_DOMAINS) throw new HttpError(400, `at most ${MAX_DOMAINS} domains per app`);
    if (store.appByDomain(domain)) throw new HttpError(409, `${domain} is already in use`, "conflict");
    return c.json({ domain: domainView(a, store.addDomain(a.id, domain)) }, 201);
  });

  app.post("/apps/:name/domains/:domain/verify", async (c) => {
    const a = await claimed(c, "admin");
    domainsEnabled(a);
    const d = store.domains(a.id).find((x) => x.domain === normDomain(c.req.param("domain")));
    if (!d) throw new HttpError(404, "domain not found", "not_found");
    if (!d.verified_at) {
      const records = await cfg.resolveTxt(`_cresslet.${d.domain}`).catch(() => [] as string[][]);
      if (!records.some((r) => r.join("") === d.token)) {
        throw new HttpError(400, `TXT _cresslet.${d.domain} = ${d.token} not found (DNS can take a few minutes)`, "unverified");
      }
      await authorize(c, a, "admin"); // again: access may have changed during the lookup (a collaborator removed)
      const v = store.verifyDomain(a.id, d.domain, d.token);
      if (v === "taken") throw new HttpError(409, `${d.domain} is already in use`, "conflict");
      if (v === "gone") throw new HttpError(404, "domain was removed", "not_found");
      runtime.logs.push(a.id, "system", `domain verified: ${d.domain}`);
    }
    return c.json({ domain: domainView(a, store.domains(a.id).find((x) => x.domain === d.domain)!) });
  });

  app.delete("/apps/:name/domains/:domain", async (c) => {
    const a = await claimed(c, "admin");
    store.deleteDomain(a.id, normDomain(c.req.param("domain")));
    return c.json({ domains: store.domains(a.id).map((d) => domainView(a, d)) });
  });

  // For a TLS terminator's on-demand certificates (e.g. Caddy `on_demand_tls { ask … }`): 200 only for
  // verified custom domains. The root and app subdomains use the wildcard cert, and approving every app
  // name would let anyone burn the CA's per-domain rate limit by creating apps.
  app.get("/domains/check", (c) => {
    const d = normDomain(c.req.query("domain") ?? "");
    // The preview host needs a certificate too when it isn't covered by the wildcard.
    return c.body(null, store.appByDomain(d) || (d === cfg.previewHost && !previewAppName(cfg)) ? 200 : 404);
  });

  // ---- pages: uploaded static HTML with a visibility and a retention (docs/api.md#pages)
  const pageDefaults = (acct: Account) => {
    const own = store.settings(acct).pages ?? {};
    return {
      visibility: own.visibility ?? cfg.pages.visibility,
      retentionDays: own.retentionDays !== undefined ? own.retentionDays : cfg.pages.retentionDays,
    };
  };
  const visibility = (v: unknown): Visibility => {
    if (!VISIBILITIES.includes(v as Visibility)) throw new HttpError(400, `visibility must be one of ${VISIBILITIES.join(", ")}`);
    return v as Visibility;
  };
  /** Whole days from 1 to MAX_RETENTION_DAYS, or null: keep forever. */
  const retention = (v: unknown): number | null => {
    if (v === null) return null;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_RETENTION_DAYS) {
      throw new HttpError(400, `retentionDays must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}, or null (keep forever)`);
    }
    return v as number;
  };
  const pageTitle = (v: unknown): string | null => {
    if (v === null) return null;
    if (typeof v !== "string" || v.trim().length > 200) throw new HttpError(400, "title must be a string of at most 200 characters, or null");
    return v.trim() || null;
  };
  type PageInput = { html?: unknown; files?: unknown; title?: unknown; visibility?: unknown; retentionDays?: unknown; source?: unknown };
  /** `html`: a single-file page (its index.html); `files`: a static site with an index.html at the root. */
  const pageFiles = (input: PageInput): DeployFile[] => {
    if (typeof input.html === "string") {
      if (input.files !== undefined) throw new HttpError(400, "send html or files, not both");
      return [{ path: "index.html", data: input.html }];
    }
    if (!Array.isArray(input.files)) throw new HttpError(400, "html (a string) or files (an array) required");
    return input.files as DeployFile[];
  };
  const pageView = (a: App, access?: AppAccess | null) => {
    const d = a.page_deploy_id ? store.deploy(a.page_deploy_id) : undefined;
    return {
      id: a.id,
      name: a.name,
      title: a.title,
      url: appUrl(cfg, a.name),
      visibility: a.visibility,
      retentionDays: a.retention_days,
      expiresAt: iso(a.expires_at),
      files: d?.file_count ?? 0,
      bytes: d?.bytes ?? 0,
      ...(access !== undefined ? { access } : {}),
      createdAt: iso(a.created_at),
      updatedAt: iso(a.updated_at),
    };
  };
  function getPage(name: string): App {
    const a = store.appByName(name);
    // Expired: gone, though the reaper may not have purged it yet.
    if (!a || a.kind !== "page" || (a.expires_at !== null && a.expires_at <= Date.now())) {
      throw new HttpError(404, `page not found: ${name}`, "not_found");
    }
    return a;
  }
  const checkPageQuota = (acct: Account) => {
    if (isSiteAdmin(cfg, acct)) return;
    if (store.appsByAccount(acct.id, "page").length >= cfg.limits.maxPagesPerAccount) {
      throw new HttpError(403, `page limit reached (${cfg.limits.maxPagesPerAccount} per account): delete one first`, "quota");
    }
  };
  const settingsView = (acct: Account) => ({ pages: pageDefaults(acct), defaults: { pages: cfg.pages } });

  // The account's defaults for new pages (falling back to the server's).
  app.get("/me/settings", (c) => c.json(settingsView(accountWide(c, "read"))));

  // `pages: null` goes back to the server's defaults; a key left out keeps its value.
  app.put("/me/settings", async (c) => {
    const acct = accountWide(c, "admin");
    const input = await body<{ pages?: { visibility?: unknown; retentionDays?: unknown } | null } | null>(c) ?? {};
    const settings = store.settings(store.accountById(acct.id)!);
    if (input.pages === null) delete settings.pages;
    else if (input.pages !== undefined) {
      if (typeof input.pages !== "object" || Array.isArray(input.pages)) throw new HttpError(400, "pages must be an object or null");
      const pages = { ...settings.pages };
      if (input.pages.visibility !== undefined) pages.visibility = visibility(input.pages.visibility);
      if (input.pages.retentionDays !== undefined) pages.retentionDays = retention(input.pages.retentionDays);
      settings.pages = pages;
    }
    store.setSettings(acct.id, settings);
    return c.json(settingsView(store.accountById(acct.id)!));
  });

  app.get("/pages", (c) => {
    const a = c.get("account"), t = c.get("token");
    if (!a || !t) throw new HttpError(401, "login required", "unauthorized");
    const only = tokenApps(t);
    const now = Date.now();
    return c.json({
      pages: store.appsFor(a.id, "page")
        .filter((x) => (!only || only.includes(x.id)) && (x.expires_at === null || x.expires_at > now))
        .map((x) => pageView(x, x.access)),
      defaults: pageDefaults(a),
    });
  });

  // Upload a new page. Settings left out come from the account's defaults (GET /v1/me/settings).
  app.post("/pages", async (c) => {
    const acct = accountWide(c, "deploy");
    const input = await body<PageInput | null>(c) ?? {};
    const defaults = pageDefaults(acct);
    const files = pageFiles(input);
    const settings = {
      title: input.title === undefined ? null : pageTitle(input.title),
      visibility: input.visibility === undefined ? defaults.visibility : visibility(input.visibility),
      retentionDays: input.retentionDays === undefined ? defaults.retentionDays : retention(input.retentionDays),
    };
    checkPageQuota(acct);
    // Unguessable: a link-only page's URL is all that protects it.
    let name = "";
    for (let i = 0; i < 5 && (!name || store.appByName(name, true)); i++) name = id("pg").replace("_", "-");
    if (store.appByName(name, true)) throw new HttpError(500, "could not allocate name");
    const page = await store.createPage(name, acct.id, settings, () => checkPageQuota(acct));
    try {
      await writePage(cfg, store, page, files, typeof input.source === "string" ? input.source : "api");
    } catch (e) {
      store.deleteApp(page.id);
      await removeAppFiles(cfg, page.id);
      throw e;
    }
    return c.json({ page: pageView(store.appById(page.id)!, "owner") }, 201);
  });

  app.get("/pages/:name", async (c) => {
    const a = getPage(c.req.param("name"));
    const access = await authorize(c, a, "read");
    return c.json({ page: pageView(a, access ?? null) });
  });

  // Replace the page's files (same URL). Restarts its retention clock.
  app.put("/pages/:name", async (c) => {
    const a = getPage(c.req.param("name"));
    await authorize(c, a, "deploy");
    const input = await body<PageInput | null>(c) ?? {};
    const files = pageFiles(input);
    const access = await authorize(c, a, "deploy"); // again: access may have changed while the body arrived
    if (!appDeploys.take(a.id)) {
      throw new HttpError(429, `too many uploads to ${a.name} (${cfg.limits.deploysPerHour} per hour): try later`, "rate_limited");
    }
    await writePage(cfg, store, a, files, typeof input.source === "string" ? input.source : "api");
    store.setPage(a.id, { retention_days: a.retention_days });
    return c.json({ page: pageView(store.appById(a.id)!, access ?? null) });
  });

  // Change the title, visibility or retention (a new retention counts from now).
  app.patch("/pages/:name", async (c) => {
    const a = getPage(c.req.param("name"));
    await authorize(c, a, "admin");
    const input = await body<PageInput | null>(c) ?? {};
    const change = {
      ...(input.title !== undefined ? { title: pageTitle(input.title) } : {}),
      ...(input.visibility !== undefined ? { visibility: visibility(input.visibility) } : {}),
      ...(input.retentionDays !== undefined ? { retention_days: retention(input.retentionDays) } : {}),
    };
    const access = await authorize(c, a, "admin"); // again, after the body
    store.setPage(a.id, change);
    return c.json({ page: pageView(store.appById(a.id)!, access ?? null) });
  });

  app.delete("/pages/:name", async (c) => {
    const a = getPage(c.req.param("name"));
    await authorize(c, a, "admin", { owner: true });
    await purgeApp(cfg, store, runtime, a);
    return c.json({ deleted: a.name });
  });

  // A URL that opens the page in a browser: for a private page, with a one-time ticket the page's host
  // exchanges for a session cookie (only the owner and collaborators get one).
  app.post("/pages/:name/view", async (c) => {
    const a = getPage(c.req.param("name"));
    await authorize(c, a, "read", { account: true });
    const input = await body<{ path?: unknown } | null>(c).catch(() => null) ?? {};
    const path = typeof input.path === "string" && input.path.startsWith("/") && !input.path.startsWith("//") ? input.path : "/";
    const url = new URL(path, appUrl(cfg, a.name));
    if (url.origin !== new URL(appUrl(cfg, a.name)).origin) throw new HttpError(400, "invalid path");
    if (a.visibility === "private") {
      url.searchParams.set(PAGE_TICKET_PARAM, await store.pageTicket(a.id, c.get("account")!.id, PAGE_TICKET_MS));
    }
    c.header("cache-control", "no-store");
    return c.json({ url: url.href, expiresIn: a.visibility === "private" ? PAGE_TICKET_MS / 1000 : null });
  });

  // ---- database inspection (read-only)
  function openAppDb(a: App) {
    const p = paths(cfg, a.id).db;
    if (!existsSync(p)) return null;
    return confine(new DatabaseSync(p, { readOnly: true }));
  }

  app.post("/apps/:name/db/query", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a, "read");
    const { sql, params = [] } = await body<{ sql?: string; params?: unknown[] }>(c);
    if (!sql) throw new HttpError(400, "sql required");
    const db = openAppDb(a);
    if (!db) return c.json({ rows: [] });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = db.prepare(sql).all(...(params as any[]));
      return c.json({ rows: jsonSafe(rows) });
    } catch (e) {
      throw new HttpError(400, (e as Error).message, "sql_error");
    } finally {
      db.close();
    }
  });

  app.get("/apps/:name/db", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a, "read");
    const db = openAppDb(a);
    if (!db) return c.json({ tables: {} });
    try {
      const tables = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as { name: string; sql: string }[];
      const out: Record<string, unknown> = {};
      const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
      for (const t of tables) {
        const count = db.prepare(`SELECT count(*) n FROM "${t.name.replace(/"/g, '""')}"`).get() as { n: number };
        const rows = db.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}" LIMIT ?`).all(limit);
        out[t.name] = { schema: t.sql, count: count.n, rows: jsonSafe(rows) };
      }
      return c.json({ tables: out });
    } finally {
      db.close();
    }
  });

  adminRoutes(app, { cfg, store, runtime, isAdminToken: isAdmin, body });

  app.notFound((c) => c.json({ error: "not_found", message: "no such endpoint" }, 404));
  return app;
}

/** Lowercase, no trailing dot. */
export const normDomain = (d: string) => d.trim().toLowerCase().replace(/\.$/, "");
// ≤ 243 so the `_cresslet.<domain>` TXT name stays within DNS's 253.
const DOMAIN_RE = /^(?=.{1,243}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
function validDomain(d: string) {
  return DOMAIN_RE.test(d);
}

function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) =>
    typeof x === "bigint" ? Number(x) : x instanceof Uint8Array ? { $bytes: encodeBase64(x) } : x));
}
