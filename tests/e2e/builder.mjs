// Browser e2e for the AI builder: save a key, ask for a change, Claude's tool calls edit the project (the preview
// updates), run a command and deploy through `cresslet deploy`; then Forget key. api.anthropic.com is replaced by a
// scripted stream (page.route), so no key or network is needed; the requests the studio sends are checked.
// Run with the server up (npm run dev): cd tests/e2e && npm i && node builder.mjs [outdir]
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const out = process.argv[2] ?? ".";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

/** One streamed Messages API reply (server-sent events), from content blocks. */
function sse(content, stopReason) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let s = ev("message_start", { message: { id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  content.forEach((b, index) => {
    if (b.type === "text") {
      s += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const part of b.text.match(/.{1,8}/gs)) s += ev("content_block_delta", { index, delta: { type: "text_delta", text: part } });
    } else {
      s += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (let i = 0; i < json.length; i += 12) s += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 12) } });
    }
    s += ev("content_block_stop", { index });
  });
  return s + ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } }) + ev("message_stop", {});
}
const replies = [
  [[{ type: "text", text: "I'll rename the heading." }, { type: "tool_use", id: "t1", name: "edit_file", input: { path: "src/App.tsx", old_text: "<h1>Todos</h1>", new_text: "<h1>Tasks</h1>" } }], "tool_use"],
  [[{ type: "tool_use", id: "t2", name: "run_command", input: { command: "ls src" } }, { type: "tool_use", id: "t3", name: "read_file", input: { path: ".env.cresslet" } }], "tool_use"],
  [[{ type: "tool_use", id: "t4", name: "run_command", input: { command: "cresslet deploy" } }], "tool_use"],
  [[{ type: "text", text: "Renamed the heading to Tasks and deployed it." }], "end_turn"],
];
const requests = [];
const cors = { "access-control-allow-origin": base, "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
await page.route("https://api.anthropic.com/**", async (route) => {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  requests.push({ url: req.url(), headers: await req.allHeaders(), body: req.postDataJSON() });
  const r = replies.shift();
  if (!r) return route.fulfill({ status: 500, headers: cors, body: "{}" });
  await new Promise((res) => setTimeout(res, 300)); // long enough to see "working"
  return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse(...r) });
});

const fail = (m) => { throw new Error(m); };
try {
  await page.goto(base + "/");
  await page.getByRole("button", { name: /react/ }).click();
  await page.waitForURL(/#\/p\//);
  const frame = page.frameLocator("#preview");
  await frame.getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  console.log("preview rendered");

  const toggle = page.getByRole("button", { name: "AI builder", exact: true });
  await toggle.click();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") fail("toggle not expanded");
  const key = page.getByLabel("Anthropic API key");
  if (!(await key.evaluate((e) => e === document.activeElement))) fail("key field not focused on open");
  await key.fill("sk-ant-e2e-test");
  await page.getByRole("button", { name: "Save key" }).click();
  const input = page.getByLabel("Message to Claude");
  await input.waitFor();
  if (!(await input.evaluate((e) => e === document.activeElement))) fail("message field not focused after saving the key");
  if ((await page.evaluate(() => localStorage.getItem("cresslet.anthropicKey"))) !== "sk-ant-e2e-test") fail("key not saved");
  await page.screenshot({ path: `${out}/builder-open.png` });

  await input.fill("Rename the heading to Tasks and deploy");
  await input.press("Enter");
  await page.locator("#builder-stop").waitFor({ state: "visible" });
  console.log("working");
  await page.locator(".msg.assistant", { hasText: "Renamed the heading to Tasks and deployed it." }).waitFor({ timeout: 90000 });
  await frame.getByRole("heading", { name: "Tasks" }).waitFor({ timeout: 30000 });
  console.log("preview shows the edit");
  const steps = await page.locator("#builder-log .step").allInnerTexts();
  console.log("steps:", JSON.stringify(steps));
  const want = ["Edited src/App.tsx", "Ran ls src", /^read_file: .env.cresslet is a local secrets file/, "Ran cresslet deploy"];
  want.forEach((w, i) => (typeof w === "string" ? steps[i]?.startsWith(w) : w.test(steps[i] ?? "")) || fail(`step ${i}: ${steps[i]}`));
  if ((await page.locator("#builder-log .step[data-state=error]").count()) !== 1) fail("expected exactly one failed step (the secrets file)");
  if (!(await page.locator("#builder-stop").isHidden())) fail("Stop still shown");
  if ((await page.locator("#open-file").textContent()) === "src/App.tsx" && !(await page.locator(".cm-content").innerText()).includes("<h1>Tasks</h1>")) fail("editor shows the old file");

  // The requests: the user's key, straight from the browser, the model and tools; each tool result sent back.
  if (requests.length !== 4) fail(`${requests.length} requests`);
  const [r1, r2, r3, r4] = requests;
  if (r1.headers.authorization !== "Bearer sk-ant-e2e-test") fail(`key not sent: ${JSON.stringify(r1.headers)}`); // SDK 1.x: API keys go as Bearer
  if (r1.headers["anthropic-dangerous-direct-browser-access"] !== "true") fail("not a browser request");
  if (r1.body.model !== "claude-opus-5-5" || !r1.body.stream || r1.body.tools.length !== 7) fail(`request: ${JSON.stringify(r1.body).slice(0, 300)}`);
  if (!/server-side-fallback-2026-07-01/.test(r1.headers["anthropic-beta"] ?? "")) fail("fallback beta header missing");
  const results = (r) => r.body.messages.at(-1).content;
  if (results(r2)[0].content !== "edited src/App.tsx") fail(`edit result: ${JSON.stringify(results(r2))}`);
  const [ls, secret] = results(r3);
  if (!/exit code 0\n[\s\S]*App\.tsx/.test(ls.content)) fail(`ls result: ${ls.content}`);
  if (!secret.is_error || /=/.test(secret.content)) fail(`secret result: ${JSON.stringify(secret)}`);
  const deployed = results(r4)[0];
  console.log("deploy result:", deployed.content.split("\n").slice(0, 4).join(" | "));
  const url = /deployed \S+ → (\S+)/.exec(deployed.content)?.[1] ?? fail("no deploy URL in the tool result");
  await page.locator("#deploy-link").waitFor({ state: "visible", timeout: 10000 });
  if ((await page.locator("#deploy-link").getAttribute("href")) !== url) fail("deploy link not updated");
  const live = await browser.newPage();
  await live.goto(url);
  await live.getByRole("heading", { name: "Tasks" }).waitFor({ timeout: 15000 });
  await live.close();
  console.log("deployed through the builder:", url);
  await page.screenshot({ path: `${out}/builder-done.png` });

  // New chat clears the log; Forget key goes back to the key form and drops the key.
  await page.getByRole("button", { name: "New chat" }).click();
  if (await page.locator("#builder-log > *").count()) fail("New chat kept the log");
  await page.getByRole("button", { name: "Forget key" }).click();
  await key.waitFor();
  if ((await page.evaluate(() => localStorage.getItem("cresslet.anthropicKey"))) !== null) fail("key not removed");
  // Reflow: open at 320 CSS px, no horizontal page scroll.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(300);
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 320) fail(`workspace with the builder open is ${w}px wide at 320px`);
  await page.locator("#builder").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/builder-phone.png` });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByRole("button", { name: "Close AI builder" }).click();
  if (!(await page.locator("#builder").isHidden()) || !(await toggle.evaluate((e) => e === document.activeElement))) fail("close: pane shown or focus lost");
  console.log("PASS");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", e.message);
  await page.screenshot({ path: `${out}/builder-fail.png` });
  console.log(await page.locator("#builder-log").innerText().catch(() => ""));
} finally {
  console.log(logs.slice(-20).join("\n"));
  await browser.close();
}
