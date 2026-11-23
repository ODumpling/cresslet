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
  const srv = await createServer(loadConfig({
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
    await srv.close();
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
    assert.equal((await grant("adm", { email: "a@b.co", credits: 0.0004 })).status, 400, "rounds to 0 millicredits");
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

    // The history a page at a time, newest first; bad paging values fall back or clamp.
    const page = async (q: string) => (await t.json(`/v1/me/credits${q}`, { headers: t.bearer(tok) })).body;
    const all = await page("");
    assert.ok(all.historyTotal >= 3);
    assert.equal(all.history.length, all.historyTotal);
    assert.deepEqual((await page("?limit=1")).history, all.history.slice(0, 1));
    assert.deepEqual((await page("?offset=1&limit=2")).history, all.history.slice(1, 3));
    assert.equal((await page("?offset=1&limit=2")).historyTotal, all.historyTotal);
    assert.deepEqual((await page(`?offset=${all.historyTotal}`)).history, []);
    assert.deepEqual((await page("?offset=-5&limit=x")).history, all.history);
    assert.deepEqual((await page("?offset=&limit=&upTo=")).history, all.history);
    assert.deepEqual((await page("?upTo=x")).history, all.history);
    assert.equal((await page("?limit=0")).history.length, 1);
    // Paging from the same newest entry: a grant made meanwhile doesn't shift the next page.
    assert.equal(typeof all.historyUpTo, "number");
    await grant("adm", { email: "a@b.co", credits: 1, note: "meanwhile" });
    const later = await page(`?offset=1&limit=2&upTo=${all.historyUpTo}`);
    assert.deepEqual(later.history, all.history.slice(1, 3));
    assert.equal(later.historyTotal, all.historyTotal);
    assert.equal(later.historyUpTo, all.historyUpTo);
    const fresh = await page("?limit=1");
    assert.equal(fresh.history[0].note, "meanwhile");
    assert.equal(fresh.historyTotal, all.historyTotal + 1);
    assert.ok(fresh.historyUpTo > all.historyUpTo);

    // Another account's wallet is its own.
    const other = await t.account("o@b.co");
    assert.equal((await t.json("/v1/me/credits", { headers: t.bearer(other) })).body.available, 1);
    assert.deepEqual((await t.json("/v1/me/credits", { headers: t.bearer(other) })).body.historyTotal, 0);
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
  const mod = "../studio/builder.ts"; // browser module: typed by studio/tsconfig.json, not this program
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
      client: () => creditsClient({ token: tok }, origin),
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
      client: () => creditsClient({ token: "clv_acct_revoked" }, origin),
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

test("AI credits admin view: totals, per model and per day, accounts, the ledger, one account", async () => {
  const t = await setup({ monthlyCredits: 1 });
  try {
    const a = await t.account("a@b.co");
    const boss = await t.account("boss@b.co");
    await t.account("idle@b.co"); // no wallet: not listed
    const view = (by: string, path = "") => t.json(`/v1/admin/credits${path}`, { headers: t.bearer(by) });
    assert.equal((await t.json("/v1/admin/credits")).status, 401);
    assert.equal((await view(a)).status, 403);
    assert.equal((await view(a, "/accounts/x")).status, 403);

    // a: 1.94 credits (1 of them free), then 10 granted by the operator; boss: 0.14 credits, all free.
    t.replies.push(t.streamed(sse("claude-opus-5-5", { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1000 }, { output_tokens: 500 })));
    await (await t.message(a)).text();
    t.replies.push(t.streamed(sse("claude-sonnet-5-5", { input_tokens: 200, output_tokens: 1 }, { output_tokens: 100 })));
    await (await t.message(boss)).text();
    const g = await t.json("/v1/admin/accounts/credits", { method: "POST", headers: t.bearer(boss), body: JSON.stringify({ email: "a@b.co", credits: 10, note: "beta" }) });
    assert.equal(g.status, 200);

    const r = await view("adm");
    assert.equal(r.status, 200);
    const d = r.body;
    assert.equal(d.enabled, true);
    assert.equal(d.monthlyCredits, 1);
    assert.equal(d.period, new Date().toISOString().slice(0, 7));
    // 200 × $2 + 100 × $10 per MTok = 1400 µ$ = 0.14 credits
    assert.deepEqual(d.totals, { used: 2.08, free: 1.14, usd: 0.0208, requests: 2, granted: 10, grants: 1, balance: 9.06, overdrawn: 0, accounts: 2, active: 2 });
    assert.deepEqual(d.models, [
      { model: "claude-opus-5-5", credits: 1.94, requests: 1, usd: 0.0194, inputTokens: 4000, outputTokens: 500 },
      { model: "claude-sonnet-5-5", credits: 0.14, requests: 1, usd: 0.0014, inputTokens: 200, outputTokens: 100 },
    ]);
    assert.equal(d.days.length, 30);
    assert.deepEqual(d.days.at(-1), { date: new Date().toISOString().slice(0, 10), credits: 2.08, requests: 2 });
    assert.equal(d.days[0].credits, 0);
    assert.deepEqual(d.accounts.map((x: { email: string }) => x.email), ["a@b.co", "boss@b.co"], "most used first; no wallet, not listed");
    const acct = d.accounts[0];
    assert.deepEqual({ ...acct, id: undefined, lastUsedAt: undefined }, {
      id: undefined, email: "a@b.co", github: null, balance: 9.06, monthlyUsed: 1, available: 9.06, used: 1.94, requests: 1, lastUsedAt: undefined,
    });
    assert.ok(acct.lastUsedAt);
    assert.equal(d.accounts[1].available, 0.86);

    // The ledger across accounts, a page at a time.
    assert.equal((await view(a, "/activity")).status, 403);
    const all = (await view("adm", "/activity")).body;
    assert.equal(all.enabled, true);
    assert.equal(all.total, 3);
    assert.equal(typeof all.upTo, "number");
    assert.deepEqual(all.entries.map((x: { kind: string; account: { email: string } }) => [x.kind, x.account.email]),
      [["grant", "a@b.co"], ["usage", "boss@b.co"], ["usage", "a@b.co"]]);
    assert.deepEqual({ ...all.entries[0], at: undefined, account: undefined }, { at: undefined, kind: "grant", credits: 10, note: "beta", by: "boss@b.co", account: undefined });
    assert.deepEqual(all.entries[0].account, { id: acct.id, email: "a@b.co", github: null });
    assert.equal(all.entries[2].usd, 0.0194);
    assert.equal(all.entries[2].free, 1);
    const p2 = (await view("adm", `/activity?offset=1&limit=1&upTo=${all.upTo}`)).body;
    assert.deepEqual(p2.entries, all.entries.slice(1, 2));
    assert.equal(p2.total, 3);
    // One account's; unknown ids 404.
    const mine = (await view(boss, `/activity?account=${acct.id}`)).body;
    assert.equal(mine.total, 2);
    assert.deepEqual(mine.entries.map((h: { kind: string; credits: number }) => [h.kind, h.credits]), [["grant", 10], ["usage", -1.94]]);
    assert.deepEqual((await view(boss, `/activity?account=${acct.id}&offset=1`)).body.entries, mine.entries.slice(1));
    assert.equal((await view("adm", "/activity?account=nope")).status, 404);

    // One account: its wallet and ledger; a site admin's session works too, unknown ids 404.
    const one = await view(boss, `/accounts/${acct.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.account.email, "a@b.co");
    assert.equal(one.body.account.siteAdmin, false);
    assert.equal(one.body.account.available, 9.06);
    assert.equal((await view("adm", "/accounts/nope")).status, 404);
    // An account with no wallet yet: zeros.
    const idle = (await t.json("/v1/me", { headers: t.bearer(await t.account("new@b.co")) })).body.account.id;
    const empty = (await view("adm", `/accounts/${idle}`)).body;
    assert.deepEqual({ ...empty.account, id: undefined }, {
      id: undefined, email: "new@b.co", github: null, siteAdmin: false, balance: 0, monthlyUsed: 0, available: 1, used: 0, requests: 0, lastUsedAt: null,
    });
    assert.deepEqual((await view("adm", `/activity?account=${idle}`)).body, { enabled: true, entries: [], total: 0, upTo: 0 });
  } finally {
    await t.close();
  }
});

test("AI credits admin view: off without AI credits", async () => {
  const t = await setup(null);
  try {
    assert.deepEqual((await t.json("/v1/admin/credits", { headers: t.bearer("adm") })).body, { enabled: false });
    assert.deepEqual((await t.json("/v1/admin/credits/activity", { headers: t.bearer("adm") })).body, { enabled: false });
  } finally {
    await t.close();
  }
});

test("a reply naming the dated snapshot of a model is priced as that model, not the ceiling", () => {
  const u = { input_tokens: 1000, output_tokens: 1000 };
  assert.equal(usageCost("claude-haiku-4-5-20251001", u), usageCost("claude-haiku-4-5", u));
  assert.ok(usageCost("claude-unknown-20251001", u) > usageCost("claude-haiku-4-5", u), "unknown: still the ceiling");
});
