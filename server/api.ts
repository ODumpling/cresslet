// Control-plane HTTP API (/v1). Used by cresslet-cli, the studio, and agents.
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { appUrl, type Config, paths, previewAppName, previewOrigin, rootUrl } from "./config.ts";
import { type Account, type App, type Domain, type Role, ROLES, SITE_ADMIN, type Store, type Token } from "./store.ts";
import type { Runtime } from "./runtime.ts";
import { github } from "./github.ts";
import { confine } from "./bindings.ts";
import { normalizeEgress } from "./egress.ts";
import { adminRoutes, isSiteAdmin, purgeApp } from "./admin.ts";
import { RateLimit } from "./limits.ts";
import {
  type DeployInput,
  HttpError,
  randomName,
  removeAppFiles,
  validName,
  writeDeploy,
} from "./deploys.ts";

export const VERSION = "0.1.0";
const TEMPLATES = join(import.meta.dirname, "../templates");
const encodeBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** `remoteAddr`: the TCP peer (main.ts passes it; tests don't). */
type Env = { Bindings: { remoteAddr?: string }; Variables: { account?: Account; token?: Token; bearer?: string } };

export function api(cfg: Config, store: Store, runtime: Runtime) {
  const app = new Hono<Env>().basePath("/v1");
  app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-cresslet-deploy-key"] }));

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

  /** The app's owner with a token allowing `role` on it, or the app's deploy key (full access to that app). */
  async function authorize(c: Context<Env>, a: App, role: Role) {
    const acct = c.get("account"), t = c.get("token");
    let scopeError: string | undefined;
    if (acct && t && a.account_id === acct.id) {
      const apps = tokenApps(t);
      if (apps && !apps.includes(a.id)) scopeError = `this token is not scoped to app ${a.name}`;
      else if (!atLeast(t, role)) scopeError = `this token can't do that (needs ${role} access, has ${t.role})`;
      else return;
    }
    const key = deployKey(c);
    if (key && await store.checkDeployKey(a.id, key)) return;
    throw new HttpError(a.account_id || key || acct ? 403 : 401, scopeError ?? `not authorized for app ${a.name}`, "forbidden");
  }

  function getApp(name: string): App {
    const a = store.appByName(name);
    if (!a) throw new HttpError(404, `app not found: ${name}`, "not_found");
    return a;
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
      auth: { github: !!cfg.github },
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
        if (!app || app.account_id !== a.id) throw new HttpError(400, `not one of your apps: ${String(n)}`);
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
    const input = await body<DeployInput & { app?: string }>(c);
    const acct = c.get("account");
    let target = input.app ? store.appByName(input.app) : undefined;
    let createdKey: string | undefined;
    if (target) {
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
      if (acct) checkAppQuota(acct);
      else {
        if (store.anonAppCount() >= cfg.limits.maxAnonApps) {
          throw new HttpError(429, "too many anonymous apps on this server right now: log in to deploy (cresslet login)", "rate_limited");
        }
        if (!anonApps.take(clientIp(c))) {
          throw new HttpError(429, `too many new anonymous apps from your address (${cfg.limits.anonAppsPerHour} per hour): log in, or try later`, "rate_limited");
        }
      }
      const expires = acct ? null : Date.now() + cfg.limits.anonTtlMs;
      const created = await store.createApp(name, expires, acct?.id ?? null);
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
    return c.json({ apps: store.appsByAccount(a.id).filter((x) => !only || only.includes(x.id)).map(view) });
  });

  app.get("/apps/:name", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a, "read");
    return c.json({
      app: view(a),
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
    await authorize(c, a, "admin");
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
    await authorize(c, a, "deploy");
    const { deployId } = await body<{ deployId?: string }>(c);
    const d = deployId ? store.deploy(deployId) : store.deploys(a.id, 2)[1];
    if (!d || d.app_id !== a.id) throw new HttpError(404, "deploy not found", "not_found");
    const config = JSON.parse(await readFile(join(paths(cfg, a.id).deploy(d.id), "deploy.json"), "utf8"));
    store.setCurrentDeploy(a.id, d.id, config);
    runtime.stop(a.id);
    runtime.logs.push(a.id, "system", `rolled back to ${d.id}`);
    return c.json({ app: view(store.appById(a.id)!) });
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
    await authorize(c, a, "read");
    const n = Math.min(Number(c.req.query("n") ?? 200), cfg.limits.logLines);
    const follow = c.req.query("follow") === "1";
    const enc = new TextEncoder();
    const line = (l: unknown) => enc.encode(JSON.stringify(l) + "\n");
    let unsub = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const l of runtime.logs.recent(a.id, n)) ctrl.enqueue(line(l));
        if (!follow) return ctrl.close();
        unsub = runtime.logs.subscribe(a.id, (l) => ctrl.enqueue(line(l)));
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
    await authorize(c, a, "admin");
    if (!a.account_id) throw new HttpError(403, "secrets require a claimed app (cresslet claim)", "unclaimed");
    const input = await body<Record<string, string | null>>(c);
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
    await authorize(c, a, "admin");
    if (!a.account_id) throw new HttpError(403, "outbound network requires a claimed app (cresslet claim)", "unclaimed");
    const { allow } = await body<{ allow?: unknown }>(c);
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
    await authorize(c, a, role);
    if (!a.account_id) throw new HttpError(403, "custom domains require a claimed app (cresslet claim)", "unclaimed");
    return a;
  };

  app.get("/apps/:name/domains", async (c) => {
    const a = await claimed(c, "read");
    return c.json({ domains: store.domains(a.id).map((d) => domainView(a, d)) });
  });

  app.post("/apps/:name/domains", async (c) => {
    const a = await claimed(c, "admin");
    const raw = (await body<{ domain?: unknown } | null>(c))?.domain;
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
    const d = store.domains(a.id).find((x) => x.domain === normDomain(c.req.param("domain")));
    if (!d) throw new HttpError(404, "domain not found", "not_found");
    if (!d.verified_at) {
      const records = await cfg.resolveTxt(`_cresslet.${d.domain}`).catch(() => [] as string[][]);
      if (!records.some((r) => r.join("") === d.token)) {
        throw new HttpError(400, `TXT _cresslet.${d.domain} = ${d.token} not found (DNS can take a few minutes)`, "unverified");
      }
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
