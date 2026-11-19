// Per-app sandbox entry, run inside workerd (see server/runtime.ts). Wraps the app's fetch
// handler and builds the documented `env` (docs/app-format.md) on top of workerd bindings:
//   HOST     service binding to the control plane, which owns the app's db and files
//   (secrets are fetched once from HOST /secrets, so they never sit on disk in plaintext)
//   APP      json binding { id, name, url, deployId }
import { Buffer } from "node:buffer";
import * as mod from "app";

const exp = mod.default ?? mod;
const handler = typeof exp === "function"
  ? exp
  : typeof exp?.fetch === "function"
  ? exp.fetch.bind(exp)
  : undefined;
const scheduled = typeof exp?.scheduled === "function" ? exp.scheduled.bind(exp) : undefined;

// SQL values cross the binding as JSON; bigints and blobs are tagged.
const replacer = (_k, v) =>
  typeof v === "bigint"
    ? { $bigint: String(v) }
    : v instanceof Uint8Array
    ? { $bytes: Buffer.from(v).toString("base64") }
    : v instanceof ArrayBuffer
    ? { $bytes: Buffer.from(v).toString("base64") }
    : v;
const reviver = (_k, v) =>
  v && typeof v === "object" && typeof v.$bytes === "string"
    ? new Uint8Array(Buffer.from(v.$bytes, "base64"))
    : v;

let appEnv;
async function makeEnv(bindings) {
  const host = bindings.HOST;
  const check = async (r) => {
    if (r.ok) return r;
    const msg = await r.text();
    throw new Error(msg || `binding error ${r.status}`);
  };
  const db = async (op, body) => {
    const r = await check(
      await host.fetch(`http://host/db/${op}`, { method: "POST", body: JSON.stringify(body, replacer) }),
    );
    return JSON.parse(await r.text(), reviver);
  };
  const secrets = await (await check(await host.fetch("http://host/secrets"))).json();
  const fileUrl = (key) => `http://host/files?key=${encodeURIComponent(key)}`;
  return {
    db: {
      query: (sql, ...params) => db("query", { sql, params }),
      first: (sql, ...params) => db("first", { sql, params }),
      run: (sql, ...params) => db("run", { sql, params }),
      exec: async (sql) => void (await db("exec", { sql })),
    },
    files: {
      async put(key, body, opts = {}) {
        const type = opts.contentType ?? (body instanceof Blob && body.type) ?? "application/octet-stream";
        await check(
          await host.fetch(fileUrl(key), {
            method: "PUT",
            body,
            headers: { "content-type": type || "application/octet-stream" },
          }),
        );
      },
      async get(key) {
        const r = await host.fetch(fileUrl(key));
        if (r.status === 404) return null;
        await check(r);
        return new Response(r.body, {
          headers: { "content-type": r.headers.get("content-type"), "content-length": r.headers.get("content-length") },
        });
      },
      async delete(key) {
        await check(await host.fetch(fileUrl(key), { method: "DELETE" }));
      },
      async list(prefix = "") {
        const r = await check(await host.fetch(`http://host/files/list?prefix=${encodeURIComponent(prefix)}`));
        return r.json();
      },
    },
    secrets: Object.freeze(secrets),
    app: Object.freeze({ ...bindings.APP }),
  };
}

async function runScheduled({ cron, scheduledTime }, bindings, ctx) {
  if (!scheduled) {
    console.error(`cron "${cron}": server/index has no scheduled() export`);
    return new Response(null, { status: 501 });
  }
  let env;
  try {
    env = await (appEnv ??= makeEnv(bindings));
  } catch (err) {
    appEnv = undefined;
    console.error(`failed to load secrets: ${err.message}`);
    return new Response(null, { status: 500 });
  }
  // The run counts as done (and failed) including work handed to ctx.waitUntil().
  const pending = [];
  const sctx = { waitUntil: (p) => void pending.push(Promise.resolve(p)), passThroughOnException: () => ctx.passThroughOnException?.() };
  // Drain until empty: waitUntil work may register more waitUntil work.
  const drain = async () => {
    const results = [];
    while (pending.length) results.push(...(await Promise.allSettled(pending.splice(0))));
    return results;
  };
  try {
    let results;
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
  async fetch(raw, bindings, ctx) {
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
      env = await appEnv;
    } catch (err) {
      appEnv = undefined;
      console.error(`failed to load secrets: ${err.message}`);
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
