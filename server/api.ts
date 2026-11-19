// Control-plane HTTP API (/v1). Used by cresslet-cli, the studio, and agents.
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { appUrl, type Config, paths, rootUrl } from "./config.ts";
import type { Account, App, Domain, Store } from "./store.ts";
import type { Runtime } from "./runtime.ts";
import { github } from "./github.ts";
import { normalizeEgress } from "./egress.ts";
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

type Env = { Variables: { account?: Account; bearer?: string } };

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
      if (bearer.startsWith("clv_acct_")) {
        const account = await store.accountByToken(bearer);
        if (!account) throw new HttpError(401, "invalid token", "unauthorized");
        c.set("account", account);
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

  async function authorize(c: Context<Env>, a: App) {
    const acct = c.get("account");
    if (acct && a.account_id === acct.id) return;
    const key = deployKey(c);
    if (key && await store.checkDeployKey(a.id, key)) return;
    throw new HttpError(a.account_id || key || acct ? 403 : 401, `not authorized for app ${a.name}`, "forbidden");
  }

  function getApp(name: string): App {
    const a = store.appByName(name);
    if (!a) throw new HttpError(404, `app not found: ${name}`, "not_found");
    return a;
  }

  const accountView = (a: Account) => ({ id: a.id, email: a.email, github: a.github_login });

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
    const token = await store.issueToken(account.id);
    return c.json({ account: accountView(account), token }, 201);
  });

  app.get("/me", (c) => {
    const a = c.get("account");
    if (!a) throw new HttpError(401, "login required", "unauthorized");
    return c.json({ account: accountView(a) });
  });

  // Revoke every token for this account (studio, CLI, CI) and issue a fresh one.
  app.post("/me/token", async (c) => {
    const a = c.get("account");
    if (!a) throw new HttpError(401, "login required", "unauthorized");
    store.revokeTokens(a.id);
    return c.json({ account: accountView(a), token: await store.issueToken(a.id) });
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
              data: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
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
      await authorize(c, target);
    } else {
      if (!acct && !cfg.anonDeploys) {
        throw new HttpError(401, "login required to deploy here (cresslet login, or set CRESSLET_TOKEN)", "unauthorized");
      }
      const name = input.app ?? uniqueName();
      if (!validName(name)) {
        throw new HttpError(400, "app name must be 1-40 chars of a-z, 0-9 and single dashes", "invalid_name");
      }
      const expires = acct ? null : Date.now() + cfg.limits.anonTtlMs;
      const created = await store.createApp(name, expires, acct?.id ?? null);
      target = created.app;
      createdKey = created.deployKey;
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
      if (!store.appByName(n)) return n;
    }
    throw new HttpError(500, "could not allocate name");
  }

  // ---- apps
  app.get("/apps", (c) => {
    const a = c.get("account");
    if (!a) throw new HttpError(401, "login required", "unauthorized");
    return c.json({ apps: store.appsByAccount(a.id).map(view) });
  });

  app.get("/apps/:name", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a);
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
    await authorize(c, a);
    runtime.stop(a.id);
    store.deleteApp(a.id);
    runtime.logs.drop(a.id);
    await removeAppFiles(cfg, a.id);
    return c.json({ deleted: a.name });
  });

  app.post("/apps/:name/claim", async (c) => {
    const acct = c.get("account");
    if (!acct) throw new HttpError(401, "login required (cresslet login)", "unauthorized");
    const a = getApp(c.req.param("name"));
    const { deployKey: k } = await body<{ deployKey?: string }>(c).catch(() => ({ deployKey: undefined }));
    const key = k ?? c.req.header("x-cresslet-deploy-key");
    if (a.account_id === acct.id) return c.json({ app: view(a) });
    if (a.account_id) throw new HttpError(409, "app already claimed", "conflict");
    if (!key || !await store.checkDeployKey(a.id, key)) throw new HttpError(403, "deploy key required", "forbidden");
    store.claimApp(a.id, acct.id);
    runtime.stop(a.id); // restart with network access
    return c.json({ app: view(store.appById(a.id)!) });
  });

  app.post("/apps/:name/rollback", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a);
    const { deployId } = await body<{ deployId?: string }>(c);
    const d = deployId ? store.deploy(deployId) : store.deploys(a.id, 2)[1];
    if (!d || d.app_id !== a.id) throw new HttpError(404, "deploy not found", "not_found");
    const config = JSON.parse(await readFile(join(paths(cfg, a.id).deploy(d.id), "deploy.json"), "utf8"));
    store.setCurrentDeploy(a.id, d.id, config);
    runtime.stop(a.id);
    runtime.logs.push(a.id, "system", `rolled back to ${d.id}`);
    return c.json({ app: view(store.appById(a.id)!) });
  });

  // ---- logs (NDJSON; ?follow=1 streams)
  app.get("/apps/:name/logs", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a);
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
    await authorize(c, a);
    return c.json({ keys: store.secretKeys(a.id) });
  });

  app.put("/apps/:name/secrets", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a);
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
    await authorize(c, a);
    store.deleteSecret(a.id, c.req.param("key"));
    runtime.stop(a.id);
    return c.json({ keys: store.secretKeys(a.id) });
  });

  // ---- egress allowlist (claimed apps; null = any public host)
  app.get("/apps/:name/egress", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a);
    return c.json({ allow: a.egress ? JSON.parse(a.egress) : null });
  });

  app.put("/apps/:name/egress", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a);
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
  const claimed = async (c: Context<Env>) => {
    const a = getApp(c.req.param("name")!);
    await authorize(c, a);
    if (!a.account_id) throw new HttpError(403, "custom domains require a claimed app (cresslet claim)", "unclaimed");
    return a;
  };

  app.get("/apps/:name/domains", async (c) => {
    const a = await claimed(c);
    return c.json({ domains: store.domains(a.id).map((d) => domainView(a, d)) });
  });

  app.post("/apps/:name/domains", async (c) => {
    const a = await claimed(c);
    const raw = (await body<{ domain?: unknown } | null>(c))?.domain;
    const domain = typeof raw === "string" ? normDomain(raw) : "";
    if (!validDomain(domain) || domain === cfg.domain || domain.endsWith("." + cfg.domain)) {
      throw new HttpError(400, `invalid domain: ${String(raw)}`);
    }
    const existing = store.domains(a.id).find((d) => d.domain === domain);
    if (existing) return c.json({ domain: domainView(a, existing) });
    if (store.domains(a.id).length >= MAX_DOMAINS) throw new HttpError(400, `at most ${MAX_DOMAINS} domains per app`);
    if (store.appByDomain(domain)) throw new HttpError(409, `${domain} is already in use`, "conflict");
    return c.json({ domain: domainView(a, store.addDomain(a.id, domain)) }, 201);
  });

  app.post("/apps/:name/domains/:domain/verify", async (c) => {
    const a = await claimed(c);
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
    const a = await claimed(c);
    store.deleteDomain(a.id, normDomain(c.req.param("domain")));
    return c.json({ domains: store.domains(a.id).map((d) => domainView(a, d)) });
  });

  // For a TLS terminator's on-demand certificates (e.g. Caddy `on_demand_tls { ask … }`): 200 only for
  // verified custom domains. The root and app subdomains use the wildcard cert, and approving every app
  // name would let anyone burn the CA's per-domain rate limit by creating apps.
  app.get("/domains/check", (c) => c.body(null, store.appByDomain(normDomain(c.req.query("domain") ?? "")) ? 200 : 404));

  // ---- database inspection (read-only)
  function openAppDb(a: App) {
    const p = paths(cfg, a.id).db;
    if (!existsSync(p)) return null;
    return new DatabaseSync(p, { readOnly: true });
  }

  app.post("/apps/:name/db/query", async (c) => {
    const a = getApp(c.req.param("name"));
    await authorize(c, a);
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
    await authorize(c, a);
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
