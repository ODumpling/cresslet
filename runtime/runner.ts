// Per-app sandbox entry. Spawned by server/runtime.ts as:
//   deno run --no-prompt --allow-read=<app> --allow-write=<data>,<sock> [--allow-net] runner.ts <config.json>
// Serves the app's fetch handler on a unix socket.
import { createEnv, type RunConfig } from "./bindings.ts";

export const READY = "__CLOVER_READY__";

const cfg: RunConfig = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const env = createEnv(cfg);

type Handler = (req: Request, env: unknown, ctx: unknown) => Response | Promise<Response>;
const mod = await import("file://" + cfg.serverPath);
const exp = mod.default ?? mod;
const handler: Handler | undefined = typeof exp === "function"
  ? exp
  : typeof exp?.fetch === "function"
  ? exp.fetch.bind(exp)
  : undefined;
if (!handler) {
  console.error("server/index must `export default { fetch(req, env) {} }`");
  Deno.exit(1);
}

try {
  Deno.removeSync(cfg.sock);
} catch { /* not there */ }

Deno.serve({
  path: cfg.sock,
  onListen() {
    // Marker read by the host; not shown in app logs.
    console.log(READY);
  },
  onError(err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return new Response("Internal Server Error", { status: 500 });
  },
}, async (raw) => {
  const url = raw.headers.get("x-clover-url") ?? raw.url;
  const headers = new Headers(raw.headers);
  headers.delete("x-clover-url");
  const req = new Request(url, {
    method: raw.method,
    headers,
    body: raw.body,
    // @ts-ignore: required for streaming bodies
    duplex: "half",
  });
  const pending: Promise<unknown>[] = [];
  const res = await handler(req, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
  if (!(res instanceof Response)) throw new Error("fetch handler must return a Response");
  return res;
});
