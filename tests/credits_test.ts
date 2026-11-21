// AI credits: the metered Anthropic proxy (/v1/ai/v1/messages), wallets, the monthly allowance and admin grants.
// Anthropic is a local stub that streams scripted replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/main.ts";
import { type AiConfig, loadConfig } from "../server/config.ts";
import { usageCost } from "../server/credits.ts";

type Reply = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** SSE for one reply: message_start (with `start` usage), a text block, message_delta (with `end` usage). */
function sse(model: string, start: object, end: object | null, text = "hello") {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: start } }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    ev("content_block_stop", { index: 0 }),
    ...(end ? [ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: end }), ev("message_stop", {})] : []),
  ];
}

async function setup(ai: Partial<AiConfig> | null = {}) {
  const seen: { headers: IncomingMessage["headers"]; body: unknown }[] = [];
  const replies: Reply[] = [];
  const stub = httpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ headers: req.headers, body: JSON.parse(raw) });
    const r = replies.shift();
    if (!r) return void res.writeHead(500).end("{}");
    await r(req, res);
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const dataDir = await mkdtemp(join(tmpdir(), "cresslet-ai-"));
  const srv = createServer(loadConfig({
    dataDir, domain: "test.local", publicPort: 80, adminToken: "adm", siteAdmins: ["boss@b.co"],
    ai: ai && { apiKey: "sk-operator", baseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, creditsPerUsd: 100, monthlyCredits: 1, maxConcurrent: 1, ...ai },
  }));
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", "test.local");
    if (init.body) headers.set("content-type", "application/json");
    return srv.handler(new Request(`http://test.local${path}`, { ...init, headers }));
  };
  const json = async (path: string, init: RequestInit = {}) => {
    const r = await call(path, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const account = async (email: string) =>
    (await json("/v1/accounts", { method: "POST", headers: bearer("adm"), body: JSON.stringify({ email }) })).body.token as string;
  const message = (token: string | null, body: object = {}, headers: Record<string, string> = {}) =>
    call("/v1/ai/v1/messages", {
      method: "POST",
      headers: { ...(token ? bearer(token) : {}), "anthropic-version": "2023-06-01", ...headers },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1000, stream: true, messages: [{ role: "user", content: "hi" }], ...body }),
    });
  const streamed = (chunks: string[], delayMs = 0): Reply => async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_stub" });
    for (const c of chunks) {
      res.write(c);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    res.end();
  };
  const close = async () => {
    srv.close();
    stub.closeAllConnections();
    await new Promise((r) => stub.close(r));
    await rm(dataDir, { recursive: true, force: true });
  };
  return { srv, call, json, bearer, account, message, streamed, replies, seen, close };
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

test("usage cost: list prices, cache writes by TTL, long prompts, fallback attempts", () => {
  // $4 / $20 per MTok, cache read $0.20, 5-minute writes ×1.25, 1-hour ×2: micro-dollars = tokens × $/MTok
  assert.equal(usageCost("claude-opus-5-5", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1000 }), 4000 + 10000 + 400 + 5000);
  assert.equal(usageCost("claude-opus-5-5", { cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } }), 100 * 5 + 200 * 8);
  assert.equal(usageCost("claude-haiku-5-5", { input_tokens: 1000, output_tokens: 1000 }), 100 + 500);
  assert.equal(usageCost("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 1000 }), 200_000 * 0.5 + 2500);
  assert.equal(usageCost("claude-unknown-9", { input_tokens: 1000 }), 10_000); // the highest price
  // every attempt counts, each at its own model's price
  assert.equal(usageCost("claude-opus-4-8", {
    input_tokens: 100, output_tokens: 10,
    iterations: [{ type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 5 }, { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 10 }],
  }), 100 * 4 + 5 * 20 + 100 * 5 + 10 * 25);
});

test("AI credits off: advertised as off, the proxy answers 404", async () => {
  const t = await setup(null);
  try {
    assert.equal((await t.json("/v1")).body.ai.credits, false);
    const tok = await t.account("a@b.co");
    assert.equal((await t.message(tok)).status, 404);
    assert.deepEqual((await t.json("/v1/me/credits", { headers: t.bearer(tok) })).body, { enabled: false });
  } finally {
    await t.close();
  }
});

test("AI credits: proxied with the operator's key, charged from the monthly allowance then the balance, grants", async () => {
  const t = await setup();
  try {
    const meta = (await t.json("/v1")).body;
    assert.deepEqual(meta.ai, { credits: true, monthlyCredits: 1 });
    assert.equal((await t.message(null)).status, 401);
    const tok = await t.account("a@b.co");
    const reader = (await t.json("/v1/me/tokens", { method: "POST", headers: t.bearer(tok), body: JSON.stringify({ name: "r", role: "read" }) })).body.token;
    assert.equal((await t.message(reader)).status, 403);

    // Only plain streamed requests with client tools and the builder's beta.
    for (const [body, headers] of [
      [{ stream: false }, {}],
      [{ speed: "fast" }, {}],
      [{ model: "gpt-5" }, {}],
      [{ max_tokens: 500_000 }, {}],
      [{ tools: [{ type: "web_search_20260209", name: "web_search" }] }, {}],
      [{ output_config: { task_budget: { type: "tokens", total: 50000 } } }, {}],
      [{}, { "anthropic-beta": "server-side-fallback-2026-07-01,mcp-client-2025-11-20" }],
    ] as const) {
      const r = await t.message(tok, body, headers);
      assert.equal(r.status, 400, JSON.stringify(body) + JSON.stringify(headers));
      assert.equal((await r.json()).type, "error"); // the Anthropic shape, so the SDK reads its message
    }
    assert.equal(t.seen.length, 0, "nothing invalid reaches Anthropic");

    const free = (await t.json("/v1/me/credits", { headers: t.bearer(tok) })).body;
    assert.equal(free.available, 1);
    assert.deepEqual({ ...free.monthly, resetsAt: undefined }, { allowance: 1, used: 0, remaining: 1, resetsAt: undefined });

    // 19400 µ$ (see the usage cost test) × 100 credits per $ = 1.94 credits: 1 from the allowance, 0.94 overdrawn.
    const chunks = sse("claude-opus-5-5", { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1000 }, { output_tokens: 500 });
    t.replies.push(t.streamed(chunks));
    const tools = [{ name: "read_file", description: "x", input_schema: { type: "object" }, eager_input_streaming: true }];
    const r = await t.message(tok, { tools, fallbacks: "default", output_config: { effort: "medium" } }, { "anthropic-beta": "server-side-fallback-2026-07-01" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("request-id"), "req_stub");
    assert.equal(await r.text(), chunks.join(""), "streamed through unchanged");
    const up = t.seen[0];
    assert.equal(up.headers["x-api-key"], "sk-operator");
    assert.equal(up.headers.authorization, undefined, "the Cresslet token never goes to Anthropic");
    assert.equal(up.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.equal((up.body as { model: string }).model, "claude-opus-5-5");

    const after = (await t.json("/v1/me/credits", { headers: t.bearer(tok) })).body;
    assert.equal(after.balance, -0.94);
    assert.equal(after.available, -0.94);
    assert.equal(after.monthly.used, 1);
    assert.deepEqual(after.history[0], {
      at: after.history[0].at, kind: "usage", credits: -1.94, model: "claude-opus-5-5",
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 1000, estimated: false,
    });

    // Out of credits: refused before Anthropic.
    const out = await t.message(tok);
    assert.equal(out.status, 402);
    assert.equal((await out.json()).error.type, "credits_exhausted");
    assert.equal(t.seen.length, 1);

    // Site admins grant credits (not users, not for unknown accounts).
    const grant = (by: string, body: object) => t.json("/v1/admin/accounts/credits", { method: "POST", headers: t.bearer(by), body: JSON.stringify(body) });
    assert.equal((await grant(tok, { email: "a@b.co", credits: 10 })).status, 403);
    assert.equal((await grant("adm", { email: "nobody@b.co", credits: 10 })).status, 404);
    assert.equal((await grant("adm", { email: "a@b.co", credits: 0 })).status, 400);
    const g = await grant("adm", { email: "a@b.co", credits: 10, note: "beta tester" });
    assert.equal(g.status, 200);
    assert.equal(g.body.balance, 9.06);
    const hist = (await t.json("/v1/me/credits", { headers: t.bearer(tok) })).body.history;
    assert.deepEqual(hist[0], { at: hist[0].at, kind: "grant", credits: 10, note: "beta tester" });

    // A server-side fallback: every attempt is charged at its model's price.
    t.replies.push(t.streamed(sse("claude-opus-4-8", { input_tokens: 100, output_tokens: 1 }, {
      output_tokens: 10,
      iterations: [{ type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 5 }, { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 10 }],
    })));
    await (await t.message(tok)).text();
    // 1250 µ$ → 0.125 credits
    assert.equal((await t.json("/v1/me/credits", { headers: t.bearer(tok) })).body.balance, 8.935);

    // Another account's wallet is its own.
    const other = await t.account("o@b.co");
    assert.equal((await t.json("/v1/me/credits", { headers: t.bearer(other) })).body.available, 1);
  } finally {
    await t.close();
  }
});

test("AI credits: a reply the client stops is still read to the end and charged; one at a time; refused key", async () => {
  const t = await setup({ monthlyCredits: 5 });
  try {
    const tok = await t.account("a@b.co");
    const chunks = sse("claude-opus-5-5", { input_tokens: 100, output_tokens: 1 }, { output_tokens: 400 });
    t.replies.push(t.streamed(chunks, 30));
    const r = await t.message(tok);
    const rd = r.body!.getReader();
    await rd.read();
    // While it runs, the account's one slot is taken.
    const busy = await t.message(tok);
    assert.equal(busy.status, 429);
    await rd.cancel();
    // 100 × 4 + 400 × 20 = 8400 µ$ = 0.84 credits
    await until(async () => (await t.json("/v1/me/credits", { headers: t.bearer(tok) })).body.monthly.used === 0.84);

    // Cut off upstream before the final count: charged on an estimate (and marked so).
    t.replies.push(t.streamed(sse("claude-opus-5-5", { input_tokens: 100, output_tokens: 1 }, null, "x".repeat(300))));
    await (await t.message(tok)).text();
    const h = (await t.json("/v1/me/credits", { headers: t.bearer(tok) })).body.history[0];
    assert.equal(h.estimated, true);
    assert.equal(h.outputTokens, 100);

    // The operator's key refused: a 502 that doesn't read as the user's key being wrong.
    t.replies.push((_req, res) => void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })));
    const bad = await t.message(tok);
    assert.equal(bad.status, 502);
    assert.match((await bad.json()).error.message, /CRESSLET_ANTHROPIC_API_KEY/);
    // Other upstream errors pass through (the SDK retries 429/529 itself).
    t.replies.push((_req, res) => void res.writeHead(529, { "content-type": "application/json", "retry-after": "3" }).end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })));
    const over = await t.message(tok);
    assert.equal(over.status, 529);
    assert.equal(over.headers.get("retry-after"), "3");
    assert.equal((await over.json()).error.type, "overloaded_error");
  } finally {
    await t.close();
  }
});

test("AI builder on credits: the studio's agent loop through the real endpoint with the vendored SDK", async () => {
  const { serve } = await import("@hono/node-server");
  const mod = "../studio/builder.js"; // untyped browser module
  const { createAgent, creditsClient, errorText } = await import(mod);
  const t = await setup({ monthlyCredits: 5 });
  const http = serve({ fetch: t.srv.handler, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => http.once("listening", r));
  try {
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const tok = await t.account("a@b.co");
    t.replies.push(t.streamed(sse("claude-opus-5-5", { input_tokens: 100, output_tokens: 1 }, { output_tokens: 50 }, "Done.")));
    const events: { type: string; text?: string; delta?: string }[] = [];
    const agent = createAgent({
      client: () => creditsClient(tok, origin),
      errorText: (e: unknown) => errorText(e, { credits: true }),
      tools: { execute: async () => ({ text: "" }) },
      on: (e: { type: string }) => events.push(e),
    });
    await agent.send("rename the heading");
    assert.equal(events.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Done.", JSON.stringify(events));
    const up = t.seen[0];
    assert.equal(up.headers["x-api-key"], "sk-operator");
    assert.equal(up.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.equal((up.body as { model: string }).model, "claude-opus-5-5");
    // 100 × 4 + 50 × 20 = 1400 µ$ = 0.14 credits
    assert.equal((await t.json("/v1/me/credits", { headers: t.bearer(tok) })).body.monthly.used, 0.14);

    // Out of credits: the notice says so (no retries of a 402).
    await t.json("/v1/admin/accounts/credits", { method: "POST", headers: t.bearer("adm"), body: JSON.stringify({ email: "a@b.co", credits: -10 }) });
    events.length = 0;
    await agent.send("again");
    const notice = events.find((e) => e.type === "notice");
    assert.match(notice?.text ?? "", /out of AI credits/);
    assert.equal(t.seen.length, 1);

    // A session that's gone: says to log in again.
    const gone = createAgent({
      client: () => creditsClient("clv_acct_revoked", origin),
      errorText: (e: unknown) => errorText(e, { credits: true }),
      tools: { execute: async () => ({ text: "" }) },
      on: (e: { type: string }) => events.push(e),
    });
    events.length = 0;
    await gone.send("hi");
    assert.match(events.find((e) => e.type === "notice")?.text ?? "", /session expired/);
  } finally {
    http.close();
    await t.close();
  }
});
