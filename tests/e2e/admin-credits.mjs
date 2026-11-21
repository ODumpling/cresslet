// Browser e2e for the site admin AI credits page (#/admin-credits): usage across accounts, giving and taking back
// credits, one account's ledger. Anthropic is a stub this script starts on port 8799, so run the server against it:
//   CRESSLET_ANTHROPIC_API_KEY=sk-e2e CRESSLET_ANTHROPIC_BASE_URL=http://127.0.0.1:8799 CRESSLET_AI_MONTHLY_CREDITS=1 \
//   CRESSLET_ADMIN_TOKEN=e2e-admin npm run dev
// then: cd tests/e2e && npm i && node admin-credits.mjs [outdir]
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin";
const out = process.argv[2] ?? ".";
const fail = (m) => { throw new Error(m); };

// Each reply: 100 × $4 + 2000 × $20 per MTok = $0.0404 = 4.04 credits.
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const reply = ev("message_start", { message: { id: "msg_e2e", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }) +
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }) +
  ev("content_block_stop", { index: 0 }) +
  ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2000 } }) + ev("message_stop", {});
const stub = createServer(async (req, res) => {
  for await (const _ of req);
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(reply);
});
await new Promise((r) => stub.listen(8799, "127.0.0.1", r));

const call = async (path, token, body, method = body ? "POST" : "GET") => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
};
if (!(await (await fetch(`${base}/v1`)).json()).ai?.credits) fail("the server doesn't offer AI credits: start it as the top of this file says");
const stamp = Date.now();
const user = `user-${stamp}@example.com`, boss = `boss-${stamp}@example.com`;
const u = await call("/v1/accounts", admin, { email: user });
const b = await call("/v1/accounts", admin, { email: boss });
await call("/v1/admin/accounts/role", admin, { email: boss, role: "SiteAdmin" }, "PUT");
// The user spends credits (1 free, the rest overdrawn), then the operator gives them some.
await call("/v1/ai/v1/messages", u.token, { model: "claude-opus-5-5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("dialog", (d) => d.accept());
try {
  await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), b.token);
  await page.goto(base + "/");
  await page.getByRole("link", { name: "AI credits" }).click();
  await page.waitForURL(/#\/admin-credits$/);
  await page.getByRole("heading", { name: "AI credits", level: 1 }).waitFor();
  if ((await page.getByRole("link", { name: "AI credits" }).getAttribute("aria-current")) !== "page") fail("nav link not current");
  const row = page.getByRole("region", { name: "Accounts table" }).locator("tbody tr", { has: page.getByRole("link", { name: user, exact: true }) });
  await row.waitFor();
  // 4.04 used; available max(0, -3.04) = 0, granted left -3.04, free 1 / 1.
  const cells = await row.locator("td").allTextContents();
  if (cells[1] !== "0" || cells[2] !== "-3.04" || cells[3] !== "1 / 1" || cells[4] !== "4.04" || cells[5] !== "1") fail(`row: ${cells}`);
  await page.locator(".day-chart").waitFor();
  await page.getByText("Days with use").click();
  await page.locator(".day-table tbody tr").first().waitFor();
  await page.getByRole("cell", { name: "claude-opus-5-5", exact: true }).waitFor();
  await page.screenshot({ path: `${out}/admin-credits.png`, fullPage: true });

  // Give credits from the row's Give button (fills the form's email).
  await row.getByRole("button", { name: `Give credits to ${user}` }).click();
  if ((await page.getByLabel("Account email").inputValue()) !== user) fail("Give didn't fill the email");
  if (!(await page.getByLabel("Credits", { exact: true }).evaluate((e) => e === document.activeElement))) fail("credits field not focused");
  await page.getByLabel("Credits", { exact: true }).fill("50");
  await page.getByLabel("Note (optional)").fill("e2e top-up");
  await page.getByRole("button", { name: "Give credits", exact: true }).click();
  await page.locator("#toast", { hasText: `Gave 50 credits to ${user}. Granted balance: 46.96.` }).waitFor();
  await row.locator("td", { hasText: "46.96" }).first().waitFor();
  await page.locator("tbody tr", { hasText: "e2e top-up" }).first().waitFor();

  // Unknown account: an error in the form, nothing granted.
  await page.getByLabel("Account email").fill(`nobody-${stamp}@example.com`);
  await page.getByLabel("Credits", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Give credits", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "No account with the email" }).waitFor();

  // Less than the server's precision (a thousandth): refused here, not sent as a 0 grant.
  await page.getByLabel("Account email").fill(user);
  await page.getByLabel("Credits", { exact: true }).fill("0.0004");
  await page.getByRole("button", { name: "Give credits", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "other than 0" }).waitFor();

  // One account: its ledger, and taking credits back (confirmed).
  await row.getByRole("link", { name: user, exact: true }).click();
  await page.waitForURL(/#\/admin-credits\/acct_/);
  await page.getByRole("heading", { name: `AI credits / ${user}` }).waitFor();
  await page.locator("tbody tr", { hasText: "by boss-" }).waitFor();
  await page.locator("tbody tr", { hasText: "claude-opus-5-5" }).waitFor();
  await page.getByLabel("Credits", { exact: true }).fill("-6.96");
  await page.getByRole("button", { name: "Give credits", exact: true }).click();
  await page.locator("#toast", { hasText: "Took back 6.96 credits" }).waitFor();
  await page.locator(".stat", { hasText: "Granted left" }).locator(".value", { hasText: /^40$/ }).waitFor();
  const me = await call("/v1/me/credits", u.token);
  if (me.balance !== 40) fail(`balance via API: ${me.balance}`);
  await page.screenshot({ path: `${out}/admin-credits-account.png`, fullPage: true });

  // Reflow: no horizontal page scroll at 320 CSS px, on both pages.
  await page.setViewportSize({ width: 320, height: 640 });
  for (const h of [new URL(page.url()).hash, "#/admin-credits"]) {
    await page.goto(`${base}/${h}`);
    await page.reload();
    await page.locator(".stats").waitFor();
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    if (w > 320) fail(`${h}: page scrolls sideways at 320px (${w})`);
  }

  // Not for other accounts: the API refuses, the link isn't shown.
  const plain = await browser.newPage();
  await plain.addInitScript((t) => localStorage.setItem("cresslet.token", t), u.token);
  await plain.goto(base + "/#/admin-credits");
  await plain.getByText("Only site admins can see this page.").waitFor();
  if (await plain.getByRole("link", { name: "AI credits" }).isVisible()) fail("nav link shown to a non-admin");
  console.log("PASS");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", e.message);
  await page.screenshot({ path: `${out}/admin-credits-fail.png`, fullPage: true });
} finally {
  console.log(logs.join("\n"));
  await browser.close();
  stub.close();
}
