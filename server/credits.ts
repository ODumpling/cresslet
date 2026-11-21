// AI credits: the studio's AI builder can call Claude through this server instead of with the user's own key.
// `POST /v1/ai/v1/messages` is an Anthropic Messages endpoint (the SDK's `baseURL` is `<origin>/v1/ai`): it checks
// the request, forwards it with the operator's key (CRESSLET_ANTHROPIC_API_KEY), streams the reply back unchanged,
// and charges the account for the tokens the reply used, at list price × CRESSLET_AI_CREDITS_PER_USD.
// Each account gets CRESSLET_AI_MONTHLY_CREDITS free a month (UTC, no carry-over), used first; site admins grant
// more (`POST /v1/admin/accounts/credits`). Amounts are kept in millicredits (integers).
import type { Context, Hono } from "hono";
import type { AiConfig, Config } from "./config.ts";
import type { Account, AiLedgerRow, Role, Store, Token } from "./store.ts";
import { HttpError } from "./deploys.ts";

type Env = { Bindings: { remoteAddr?: string }; Variables: { account?: Account; token?: Token; bearer?: string } };

interface Price {
  /** USD per million tokens. Cache writes cost 1.25× input (5-minute TTL) or 2× (1 hour). */
  input: number;
  output: number;
  cacheRead: number;
  /** Prompts over `above` input tokens (cache included) are charged at these rates instead. */
  long?: { above: number; input: number; output: number; cacheRead: number };
}

/** Anthropic list prices. A request may name any of these; a reply from a model not listed is charged at MAX_PRICE. */
export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};
const MAX_PRICE: Price = { input: 10, output: 50, cacheRead: 1 };

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  /** Server-side fallback (and other server-side steps): one entry per attempt, the billing source of truth. */
  iterations?: (Usage & { type?: string; model?: string })[] | null;
}

const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

/** What one attempt cost, in micro-dollars (tokens × USD per million tokens). */
function attemptCost(model: string | undefined, u: Usage): number {
  const read = n(u.cache_read_input_tokens), written = n(u.cache_creation_input_tokens);
  let w5 = n(u.cache_creation?.ephemeral_5m_input_tokens), w1 = n(u.cache_creation?.ephemeral_1h_input_tokens);
  w5 += Math.max(0, written - w5 - w1); // TTL not broken down: the 5-minute rate
  const prompt = n(u.input_tokens) + read + w5 + w1;
  const base = (model && PRICES[model]) || MAX_PRICE;
  const p = base.long && prompt > base.long.above ? base.long : base;
  return n(u.input_tokens) * p.input + n(u.output_tokens) * p.output + read * p.cacheRead + w5 * p.input * 1.25 + w1 * p.input * 2;
}

/** A reply's cost in micro-dollars: every attempt it made (`iterations`), or the reply's own usage. */
export function usageCost(model: string | undefined, u: Usage): number {
  const own = attemptCost(model, u);
  if (!Array.isArray(u.iterations) || !u.iterations.length) return own;
  const all = u.iterations.reduce((sum, it) => sum + attemptCost(it?.model ?? model, it ?? {}), 0);
  return Math.max(all, own);
}

/** Micro-dollars → millicredits, rounded up. */
export const toMillicredits = (ai: AiConfig, microUsd: number) => Math.ceil((microUsd * ai.creditsPerUsd) / 1000);

export const period = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
/** When this month (UTC) started, in ms. */
export const periodStart = (t = Date.now()) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
export const nextPeriod = (t = Date.now()) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};
/** Millicredits → credits. */
export const credits = (millicredits: number) => Math.round(millicredits) / 1000;

/** One ledger row as the API shows it. `admin`: also who granted it, or a request's cost and free part. */
export function ledgerEntry(r: AiLedgerRow, { admin = false } = {}) {
  const d = r.detail ? JSON.parse(r.detail) : {};
  const usage = r.kind === "usage";
  return {
    at: new Date(r.created_at).toISOString(),
    kind: r.kind,
    credits: credits(r.amount),
    ...(usage
      ? { model: d.model, inputTokens: d.input, outputTokens: d.output, cacheReadTokens: d.cacheRead, cacheWriteTokens: d.cacheWrite, estimated: !!d.estimated }
      : { note: d.note ?? null }),
    ...(!admin ? {} : usage ? { usd: d.usd ?? null, free: credits(d.free ?? 0) } : { by: d.by ?? null }),
  };
}

/** Betas a request may ask for (the AI builder's); others could reach features that aren't metered. */
export const ALLOWED_BETAS = new Set(["server-side-fallback-2026-07-01"]);
const FIELDS = new Set([
  "model", "max_tokens", "messages", "system", "tools", "tool_choice", "thinking", "output_config", "cache_control",
  "fallbacks", "stream", "metadata", "stop_sequences",
]);
const OUTPUT_CONFIG = new Set(["effort", "format"]);
export const MAX_AI_BODY_BYTES = 32 * 1024 * 1024; // the Messages API's own request limit
const MAX_OUTPUT_TOKENS = 128_000;
/** A reply still streaming after this long is cut off (and charged for what it used). */
const MAX_REQUEST_MS = 30 * 60_000;

/** Why the request can't go through this proxy, or null. Only plain streamed Messages requests with client tools. */
export function checkRequest(b: unknown): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "body must be a JSON object";
  const r = b as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!FIELDS.has(k)) return `${k} isn't available with AI credits`;
  if (typeof r.model !== "string" || !PRICES[r.model]) return `model must be one of ${Object.keys(PRICES).join(", ")}`;
  if (r.stream !== true) return "only streamed requests (stream: true) are available with AI credits";
  if (!Number.isSafeInteger(r.max_tokens) || (r.max_tokens as number) < 1 || (r.max_tokens as number) > MAX_OUTPUT_TOKENS) {
    return `max_tokens must be a whole number from 1 to ${MAX_OUTPUT_TOKENS}`;
  }
  if (!Array.isArray(r.messages)) return "messages must be an array";
  if (r.tools !== undefined) {
    if (!Array.isArray(r.tools)) return "tools must be an array";
    for (const t of r.tools) {
      if (!t || typeof t !== "object") return "tools must be objects";
      const type = (t as { type?: unknown }).type;
      if (type !== undefined && type !== "custom") return `server tools (${String(type)}) aren't available with AI credits`;
    }
  }
  if (r.output_config !== undefined) {
    if (!r.output_config || typeof r.output_config !== "object") return "output_config must be an object";
    for (const k of Object.keys(r.output_config)) if (!OUTPUT_CONFIG.has(k)) return `output_config.${k} isn't available with AI credits`;
  }
  if (r.fallbacks !== undefined && r.fallbacks !== "default") {
    if (!Array.isArray(r.fallbacks)) return 'fallbacks must be "default" or a list of models';
    for (const f of r.fallbacks) {
      const m = (f as { model?: unknown })?.model;
      if (typeof m !== "string" || !PRICES[m] || Object.keys(f as object).some((k) => k !== "model")) return "fallbacks: unknown model";
    }
  }
  return null;
}

/** Reads a streamed reply's server-sent events as they pass through: its model and token usage. */
export class Meter {
  model: string | undefined;
  usage: Usage = {};
  started = false;
  /** message_delta with the final output token count arrived. */
  complete = false;
  /** Characters of text, tool input and thinking streamed: an estimate when a reply is cut off. */
  chars = 0;
  #decoder = new TextDecoder();
  #line = "";

  constructor(model: string) {
    this.model = model;
  }

  push(chunk: Uint8Array) {
    const text = this.#line + this.#decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    this.#line = lines.pop() ?? "";
    for (const l of lines) this.#event(l);
  }

  #event(line: string) {
    if (!line.startsWith("data:")) return;
    let e: { type?: string; message?: { model?: string; usage?: Usage }; usage?: Usage; delta?: Record<string, unknown> };
    try {
      e = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    if (e.type === "message_start" && e.message) {
      this.started = true;
      if (typeof e.message.model === "string") this.model = e.message.model;
      this.usage = { ...e.message.usage };
    } else if (e.type === "message_delta" && e.usage) {
      for (const [k, v] of Object.entries(e.usage)) if (v !== null && v !== undefined) (this.usage as Record<string, unknown>)[k] = v;
      if (typeof e.usage.output_tokens === "number") this.complete = true;
    } else if (e.type === "content_block_delta" && e.delta) {
      for (const k of ["text", "partial_json", "thinking"]) if (typeof e.delta[k] === "string") this.chars += (e.delta[k] as string).length;
    }
  }

  /** Usage to charge: as reported, or, for a reply cut off before its final count, output estimated from what streamed. */
  billable(): Usage {
    if (this.complete) return this.usage;
    return { ...this.usage, output_tokens: Math.max(n(this.usage.output_tokens), Math.ceil(this.chars / 3)) };
  }
}

/** A Messages API error body, so the Anthropic SDK reads its message. */
const aiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export function aiRoutes(
  app: Hono<Env>,
  { cfg, store, accountWide, readBody }: {
    cfg: Config;
    store: Store;
    accountWide: (c: Context<Env>, role: Role) => Account;
    readBody: (req: Request, maxBytes: number) => Promise<Uint8Array>;
  },
) {
  const inflight = new Map<string, number>();

  const wallet = (ai: AiConfig, acct: Account) => {
    const w = store.aiWallet(acct.id, period());
    const allowance = Math.round(ai.monthlyCredits * 1000);
    const monthly = Math.max(0, allowance - w.periodUsed);
    return { balance: w.balance, allowance, used: w.periodUsed, monthly, available: w.balance + monthly };
  };

  // The account's credits and recent usage (any whole-account token).
  app.get("/me/credits", (c) => {
    const acct = accountWide(c, "read");
    const ai = cfg.ai;
    if (!ai) return c.json({ enabled: false });
    const w = wallet(ai, acct);
    return c.json({
      enabled: true,
      creditsPerUsd: ai.creditsPerUsd,
      available: credits(w.available),
      balance: credits(w.balance),
      monthly: { allowance: credits(w.allowance), used: credits(w.used), remaining: credits(w.monthly), resetsAt: nextPeriod() },
      history: store.aiLedger(acct.id, 50).map((r) => ledgerEntry(r)),
    });
  });

  app.post("/ai/v1/messages", async (c) => {
    const ai = cfg.ai;
    if (!ai) return aiError(404, "not_found_error", "AI credits aren't enabled on this server: use your own Anthropic API key");
    let acct: Account;
    try {
      acct = accountWide(c, "deploy");
    } catch (e) {
      if (e instanceof HttpError) return aiError(e.status, e.status === 401 ? "authentication_error" : "permission_error", e.message);
      throw e;
    }
    if (wallet(ai, acct).available <= 0) {
      return aiError(402, "credits_exhausted", "You're out of AI credits. Wait for next month's free credits, ask the operator for more, or use your own Anthropic API key.");
    }
    const betas = (c.req.header("anthropic-beta") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const bad = betas.find((b) => !ALLOWED_BETAS.has(b));
    if (bad) return aiError(400, "invalid_request_error", `beta ${bad} isn't available with AI credits`);

    let bytes: Uint8Array;
    let req: Record<string, unknown>;
    try {
      bytes = await readBody(c.req.raw, MAX_AI_BODY_BYTES);
      req = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      if (e instanceof HttpError) return aiError(e.status, "request_too_large", e.message);
      return aiError(400, "invalid_request_error", "invalid JSON body");
    }
    const why = checkRequest(req);
    if (why) return aiError(400, "invalid_request_error", why);

    const busy = inflight.get(acct.id) ?? 0;
    if (busy >= ai.maxConcurrent) {
      return aiError(429, "rate_limit_error", `at most ${ai.maxConcurrent} AI requests at once per account`, { "retry-after": "5" });
    }
    inflight.set(acct.id, busy + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (inflight.get(acct.id) ?? 1) - 1;
      if (left > 0) inflight.set(acct.id, left);
      else inflight.delete(acct.id);
    };

    const version = c.req.header("anthropic-version");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), MAX_REQUEST_MS);
    let upstream: Response;
    try {
      upstream = await fetch(`${ai.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ai.apiKey,
          "anthropic-version": version && /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : "2023-06-01",
          ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
        },
        body: bytes as BodyInit,
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      release();
      console.error("cresslet: AI request failed:", e);
      return aiError(502, "api_error", "couldn't reach Anthropic");
    }
    const requestId = upstream.headers.get("request-id");
    const pass: Record<string, string> = requestId ? { "request-id": requestId } : {};
    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer);
      release();
      const text = await upstream.text().catch(() => "");
      if (upstream.status === 401 || upstream.status === 403) {
        console.error(`cresslet: Anthropic refused the server's API key (${upstream.status}): ${text.slice(0, 500)}`);
        return aiError(502, "api_error", "the server's AI provider refused its key (operator: check CRESSLET_ANTHROPIC_API_KEY)", pass);
      }
      const retry = upstream.headers.get("retry-after");
      const should = upstream.headers.get("x-should-retry");
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": "application/json", ...pass, ...(retry ? { "retry-after": retry } : {}), ...(should ? { "x-should-retry": should } : {}) },
      });
    }

    // Charged once, when the reply ends: normally, cut off, or after the client went away (the rest is still read,
    // so the charge is what Anthropic bills, not what the client chose to wait for).
    const meter = new Meter(req.model as string);
    let charged = false;
    const charge = () => {
      if (charged) return;
      charged = true;
      clearTimeout(timer);
      release();
      if (!meter.started) return; // nothing generated
      const u = meter.billable();
      const microUsd = usageCost(meter.model, u);
      const amount = toMillicredits(ai, microUsd);
      try {
        store.chargeAi(acct.id, period(), Math.round(ai.monthlyCredits * 1000), amount, {
          model: meter.model,
          input: n(u.input_tokens),
          output: n(u.output_tokens),
          cacheRead: n(u.cache_read_input_tokens),
          cacheWrite: n(u.cache_creation_input_tokens),
          usd: microUsd / 1e6,
          ...(meter.complete ? {} : { estimated: true }),
        });
      } catch (e) {
        console.error(`cresslet: couldn't charge AI credits to ${acct.id}:`, e);
      }
    };
    const reader = upstream.body.getReader();
    let cancelled = false; // the client went away: the reads below only meter, and the drain charges
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } catch (e) {
          if (!cancelled) {
            charge();
            ctrl.error(e);
          }
          return;
        }
        if (r.done) {
          if (!cancelled) {
            charge();
            ctrl.close();
          }
          return;
        }
        meter.push(r.value);
        if (!cancelled) ctrl.enqueue(r.value);
      },
      cancel() {
        cancelled = true;
        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              meter.push(value);
            }
          } catch { /* cut off: charged for what arrived */ } finally {
            charge();
          }
        })();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache", ...pass },
    });
  });
}
