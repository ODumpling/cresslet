// Per-app sandbox entry, run inside workerd (see server/runtime.ts). Wraps the app's fetch
// handler and builds the documented `env` (docs/app-format.md) on top of workerd bindings:
//   HOST     service binding to the control plane, which owns the app's db and files
//   (secrets are fetched once from HOST /secrets, so they never sit on disk in plaintext)
//   APP      json binding { id, name, url, deployId, env } (env: "production", or the environment, e.g. "staging")
// The env is also published for the `cresslet` SDK (cresslet-runtime.ts, imported before the app).
import { Buffer } from "node:buffer";
import { runtime } from "cresslet-runtime";
import * as mod from "app";

/** The app's fetch and scheduled handlers (docs/app-format.md). */
type Fetch = (req: Request, env: Env, ctx: ExecutionContext) => unknown;
type Scheduled = (event: { type: "scheduled"; cron: string; scheduledTime: number }, env: Env, ctx: Pick<ExecutionContext, "waitUntil" | "passThroughOnException">) => unknown;
/** workerd's per-request context. */
interface ExecutionContext {
  waitUntil(p: unknown): void;
  passThroughOnException?(): void;
}
/** This worker's bindings (server/runtime.ts workerdConfig). */
interface Bindings {
  HOST: { fetch(url: string, init?: RequestInit): Promise<Response> };
  APP: { id: string; name: string; url: string; deployId: string; env?: string };
}
type Env = Awaited<ReturnType<typeof makeEnv>>;
/** A bound SQL value, or what a query returns (bigints and blobs tagged on the wire). */
type SqlValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;

const exp = (mod.default ?? mod) as ((Fetch | object) & { fetch?: unknown; scheduled?: unknown }) | null | undefined; // the app's exports
const handler: Fetch | undefined = typeof exp === "function"
  ? exp
  : typeof exp?.fetch === "function"
  ? exp.fetch.bind(exp) as Fetch
  : undefined;
const scheduled = typeof exp?.scheduled === "function" ? exp.scheduled.bind(exp) as Scheduled : undefined;

// SQL values cross the binding as JSON; bigints and blobs are tagged.
const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint"
    ? { $bigint: String(v) }
    : v instanceof Uint8Array
    ? { $bytes: Buffer.from(v).toString("base64") }
    : v instanceof ArrayBuffer
    ? { $bytes: Buffer.from(v).toString("base64") }
    : v;
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && typeof (v as { $bytes?: unknown }).$bytes === "string"
    ? new Uint8Array(Buffer.from((v as { $bytes: string }).$bytes, "base64"))
    : v;

let appEnv: Promise<Env> | undefined;
async function makeEnv(bindings: Bindings) {
  const host = bindings.HOST;
  const check = async (r: Response) => {
    if (r.ok) return r;
    const msg = await r.text();
    throw new Error(msg || `binding error ${r.status}`);
  };
  const db = async (op: string, body: unknown): Promise<unknown> => {
    const r = await check(
      await host.fetch(`http://host/db/${op}`, { method: "POST", body: JSON.stringify(body, replacer) }),
    );
    return JSON.parse(await r.text(), reviver);
  };
  const secrets: Record<string, string> = await (await check(await host.fetch("http://host/secrets"))).json();
  const fileUrl = (key: string) => `http://host/files?key=${encodeURIComponent(key)}`;
  return {
    db: {
      query: (sql: string, ...params: SqlValue[]) => db("query", { sql, params }),
      raw: (sql: string, ...params: SqlValue[]) => db("raw", { sql, params }),
      first: (sql: string, ...params: SqlValue[]) => db("first", { sql, params }),
      run: (sql: string, ...params: SqlValue[]) => db("run", { sql, params }),
      exec: async (sql: string) => void (await db("exec", { sql })),
      batch: (statements: { sql: string; params?: SqlValue[]; raw?: boolean }[]) => db("batch", { statements }),
    },
    files: {
      async put(key: string, body: BodyInit | null, opts: { contentType?: string } = {}) {
        const type = opts.contentType ?? (body instanceof Blob && body.type) ?? "application/octet-stream";
        await check(
          await host.fetch(fileUrl(key), {
            method: "PUT",
            body,
            headers: { "content-type": type || "application/octet-stream" },
          }),
        );
      },
      async get(key: string) {
        const r = await host.fetch(fileUrl(key));
        if (r.status === 404) return null;
        await check(r);
        return new Response(r.body, {
          // (a missing one is the string "null", as before)
          headers: { "content-type": String(r.headers.get("content-type")), "content-length": String(r.headers.get("content-length")) },
        });
      },
      async delete(key: string) {
        await check(await host.fetch(fileUrl(key), { method: "DELETE" }));
      },
      async list(prefix = ""): Promise<unknown> {
        const r = await check(await host.fetch(`http://host/files/list?prefix=${encodeURIComponent(prefix)}`));
        return r.json();
      },
    },
    secrets: Object.freeze(secrets),
    app: Object.freeze({ ...bindings.APP }),
  };
}

async function runScheduled({ cron, scheduledTime }: { cron: string; scheduledTime: number }, bindings: Bindings, ctx: ExecutionContext) {
  if (!scheduled) {
    console.error(`cron "${cron}": server/index has no scheduled() export`);
    return new Response(null, { status: 501 });
  }
  let env;
  try {
    env = runtime.env = await (appEnv ??= makeEnv(bindings));
  } catch (err) {
    appEnv = undefined;
    console.error(`failed to load secrets: ${(err as Error).message}`);
    return new Response(null, { status: 500 });
  }
  // The run counts as done (and failed) including work handed to ctx.waitUntil().
  const pending: Promise<unknown>[] = [];
  const sctx = { waitUntil: (p: unknown) => void pending.push(Promise.resolve(p)), passThroughOnException: () => ctx.passThroughOnException?.() };
  // Drain until empty: waitUntil work may register more waitUntil work.
  const drain = async () => {
    const results: PromiseSettledResult<unknown>[] = [];
    while (pending.length) results.push(...(await Promise.allSettled(pending.splice(0))));
    return results;
  };
  try {
    let results: PromiseSettledResult<unknown>[];
    try {
      await scheduled({ type: "scheduled", cron, scheduledTime }, env, sctx);
    } finally {
      results = await drain(); // never leave waitUntil work unhandled
    }
    for (const r of results) if (r.status === "rejected") throw r.reason;
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return new Response(null, { status: 500 });
  }
}

export default {
  async fetch(raw: Request, bindings: Bindings, ctx: ExecutionContext) {
    // Readiness probe from the control plane (clients can't send x-cresslet-* headers).
    if (raw.headers.get("x-cresslet-probe")) return new Response(null, { status: 204 });
    // Only the control plane can set this (server/runtime.ts strips x-cresslet-* from clients).
    const cron = raw.headers.get("x-cresslet-scheduled");
    if (cron) return runScheduled(JSON.parse(cron), bindings, ctx);
    if (!handler) {
      console.error("server/index must `export default { fetch(req, env) {} }`");
      return new Response("Internal Server Error", { status: 500 });
    }
    appEnv ??= makeEnv(bindings);
    let env;
    try {
      env = runtime.env = await appEnv;
    } catch (err) {
      appEnv = undefined;
      console.error(`failed to load secrets: ${(err as Error).message}`);
      return new Response("Internal Server Error", { status: 500 });
    }
    const url = raw.headers.get("x-cresslet-url") ?? raw.url;
    const headers = new Headers(raw.headers);
    headers.delete("x-cresslet-url");
    const req = new Request(url, { method: raw.method, headers, body: raw.body, redirect: "manual" });
    try {
      const res = await handler(req, env, ctx);
      if (!(res instanceof Response)) throw new Error("fetch handler must return a Response");
      return res;
    } catch (err) {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
