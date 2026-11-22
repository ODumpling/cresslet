// Browser e2e for AI credits: a logged-in user's AI builder talks to Claude through the server (no key to enter),
// shows the credits left, and stops with a clear message once they're gone; Settings lists the use. Anthropic is a
// stub this script starts on port 8799, so run the server against it:
//   CRESSLET_ANTHROPIC_API_KEY=sk-e2e CRESSLET_ANTHROPIC_BASE_URL=http://127.0.0.1:8799 CRESSLET_AI_MONTHLY_CREDITS=1 \
//   CRESSLET_ADMIN_TOKEN=e2e-admin npm run dev
// then: cd tests/e2e && npm i && node credits.ts [outdir]
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin";
const out = process.argv[2] ?? ".";
const fail = (m: string): never => { throw new Error(m); };

// Each reply costs 100 × $4 + 2000 × $20 per MTok = $0.0404 = 4.04 credits: past the 1 free credit at once.
const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const reply = (text: string) => ev("message_start", { message: { id: "msg_e2e", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }) +
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
  ev("content_block_stop", { index: 0 }) +
  ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2000 } }) + ev("message_stop", {});
const seen: { headers: Record<string, string | string[] | undefined>; body: { model?: string } }[] = [];
const stub = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  seen.push({ headers: req.headers, body: JSON.parse(body) });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(reply("Hello from your credits."));
});
await new Promise<void>((r) => stub.listen(8799, "127.0.0.1", r));

const meta = await (await fetch(`${base}/v1`)).json();
if (!meta.ai?.credits) fail("the server doesn't offer AI credits: start it with CRESSLET_ANTHROPIC_API_KEY (see the top of this file)");
const acct = await (await fetch(`${base}/v1/accounts`, {
  method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ email: `credits-${Date.now()}@example.com` }),
})).json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs: string[] = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
try {
  // Logged out: the builder offers a login (credits) or an own key.
  await page.goto(base + "/");
  await page.getByRole("button", { name: /react/ }).click();
  await page.waitForURL(/\/p\//);
  await page.locator("#builder-login").waitFor();
  if (!(await page.getByLabel("Anthropic API key").isVisible())) fail("own key not offered next to the login");

  // Logged in: straight to the chat, credits shown, no key form.
  await page.evaluate((t) => localStorage.setItem("cresslet.token", t), acct.token);
  await page.reload();
  await page.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  const input = page.getByLabel("Message to Claude");
  await input.waitFor();
  await page.locator("#builder-credits", { hasText: /^1 credit$/ }).waitFor();
  if (await page.getByLabel("Anthropic API key").isVisible()) fail("key form shown with credits");
  await input.fill("Say hello");
  await input.press("Enter");
  await page.locator(".msg.assistant", { hasText: "Hello from your credits." }).waitFor({ timeout: 30000 });
  await page.locator("#builder-credits", { hasText: "0 credits" }).waitFor();
  if (seen.length !== 1 || seen[0].headers["x-api-key"] !== "sk-e2e" || seen[0].headers.authorization) fail(`upstream request: ${JSON.stringify(seen[0]?.headers)}`);
  if (seen[0].body.model !== "claude-opus-5-5") fail("model");
  await page.screenshot({ path: `${out}/credits-chat.png` });

  // Out of credits: a clear notice, and nothing sent to Anthropic.
  await input.fill("Again");
  await input.press("Enter");
  await page.locator(".notice[data-error]", { hasText: "out of AI credits" }).waitFor({ timeout: 30000 });
  if (seen.length !== 1) fail("a request went out without credits");

  // No switch to an own key while on credits.
  if (await page.locator("#builder-chat button", { hasText: /own key/i }).count()) fail("own key button shown with credits");
  console.log("builder on credits ok");

  // Settings: what's left and the use, on its own tab.
  await page.goto(base + "/settings");
  await page.locator("#settings-tab-credits").click();
  await page.locator("#credits-section").waitFor();
  await page.locator("#credits-history", { hasText: "AI builder (claude-opus-5-5)" }).waitFor();
  const avail = await page.locator("#credits-available").textContent();
  if (avail !== "0 credits") fail(`available: ${avail}`);
  await page.locator("#credits-section").screenshot({ path: `${out}/credits-settings.png` });

  // The history a page at a time: 12 grants plus the use = 13 entries, 10 a page.
  for (let i = 0; i < 12; i++) {
    await fetch(`${base}/v1/admin/accounts/credits`, {
      method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ email: acct.account.email, credits: 1, note: `grant ${i}` }),
    });
  }
  await page.reload();
  const pager = page.locator("#credits-pager [role=status]");
  await pager.filter({ hasText: "Entries 1–10 of 13" }).waitFor();
  if (await page.locator("#credits-history .list-row").count() !== 10) fail("first page isn't 10 entries");
  await page.locator("#credits-next").click();
  await pager.filter({ hasText: "Entries 11–13 of 13" }).waitFor();
  await page.locator("#credits-history", { hasText: "AI builder (claude-opus-5-5)" }).waitFor();
  if (!(await page.locator("#credits-next").isDisabled())) fail("Older enabled on the last page");
  if (await page.evaluate(() => document.activeElement?.id) !== "credits-prev") fail("focus didn't move to Newer on the last page");
  await page.locator("#credits-prev").click();
  await pager.filter({ hasText: "Entries 1–10 of 13" }).waitFor();
  console.log("PASS");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", (e as Error).message);
  await page.screenshot({ path: `${out}/credits-fail.png` });
} finally {
  console.log(logs.join("\n"));
  await browser.close();
  stub.close();
}
