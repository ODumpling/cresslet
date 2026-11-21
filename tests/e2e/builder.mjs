// Browser e2e for the AI builder: save a key, ask for a change, Claude's tool calls edit the project (the preview
// updates), run a command and deploy through `cresslet deploy` once the user approves; then Forget key. api.anthropic.com is replaced by a
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
  // clearing the marker variable doesn't skip the approval
  [[{ type: "tool_use", id: "t5", name: "run_command", input: { command: "unset CRESSLET_AI_BUILDER; cresslet deploy" } }], "tool_use"],
  [[{ type: "tool_use", id: "t4", name: "run_command", input: { command: "cresslet deploy" } }], "tool_use"],
  [[{ type: "text", text: "Renamed the heading to Tasks and deployed it." }], "end_turn"],
  // second chat: Stop after an approved deploy
  [[{ type: "tool_use", id: "t6", name: "run_command", input: { command: "cresslet deploy && sleep 30" } }], "tool_use"],
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

  // Chat first: the builder is open beside the preview from the start (no AI credits on this server: the key form).
  const toggle = page.getByRole("button", { name: "AI builder", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") fail("builder not open by default");
  const key = page.getByLabel("Anthropic API key");
  await key.waitFor();
  // Closing and reopening it: focus goes back to the toggle, then to the key field.
  await toggle.click();
  if (!(await page.locator("#builder").isHidden()) || !(await toggle.evaluate((e) => e === document.activeElement))) fail("close: pane shown or focus lost");
  await toggle.click();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") fail("toggle not expanded");
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
  // `cresslet deploy` from the builder waits for the user; focus isn't moved onto the approve button.
  await page.getByRole("button", { name: "Decline" }).click({ timeout: 90000 });
  const approveBtn = page.getByRole("button", { name: "Approve deploy" });
  await approveBtn.waitFor({ timeout: 90000 });
  if (await approveBtn.evaluate((e) => e === document.activeElement)) fail("approval took focus");
  if (!(await page.locator("#builder-status").textContent()).includes("Claude wants to deploy")) fail("approval not announced");
  await page.screenshot({ path: `${out}/builder-approve.png` });
  await approveBtn.click();
  await page.locator(".msg.assistant", { hasText: "Renamed the heading to Tasks and deployed it." }).waitFor({ timeout: 90000 });
  await frame.getByRole("heading", { name: "Tasks" }).waitFor({ timeout: 30000 });
  console.log("preview shows the edit");
  const steps = await page.locator("#builder-log .step").allInnerTexts();
  console.log("steps:", JSON.stringify(steps));
  const want = ["Edited src/App.tsx", "Ran ls src", /^read_file: .env.cresslet is a local secrets file/, "Ran unset CRESSLET_AI_BUILDER; cresslet deploy", "Deploy not approved", "Ran cresslet deploy", "Deploy approved"];
  want.forEach((w, i) => (typeof w === "string" ? steps[i]?.startsWith(w) : w.test(steps[i] ?? "")) || fail(`step ${i}: ${steps[i]}`));
  if ((await page.locator("#builder-log .step[data-state=error]").count()) !== 3) fail("expected three failed steps (the secrets file, the declined deploy and its command)");
  if (!(await page.locator("#builder-stop").isHidden())) fail("Stop still shown");
  if ((await page.locator("#open-file").textContent()) === "src/App.tsx" && !(await page.locator(".cm-content").innerText()).includes("<h1>Tasks</h1>")) fail("editor shows the old file");

  // The requests: the user's key, straight from the browser, the model and tools; each tool result sent back.
  if (requests.length !== 5) fail(`${requests.length} requests`);
  const [r1, r2, r3, r5, r4] = requests;
  if (r1.headers.authorization !== "Bearer sk-ant-e2e-test") fail(`key not sent: ${JSON.stringify(r1.headers)}`); // SDK 1.x: API keys go as Bearer
  if (r1.headers["anthropic-dangerous-direct-browser-access"] !== "true") fail("not a browser request");
  if (r1.body.model !== "claude-opus-5-5" || !r1.body.stream || r1.body.tools.length !== 7) fail(`request: ${JSON.stringify(r1.body).slice(0, 300)}`);
  if (!/server-side-fallback-2026-07-01/.test(r1.headers["anthropic-beta"] ?? "")) fail("fallback beta header missing");
  const results = (r) => r.body.messages.at(-1).content;
  if (results(r2)[0].content !== "edited src/App.tsx") fail(`edit result: ${JSON.stringify(results(r2))}`);
  const [ls, secret] = results(r3);
  if (!/exit code 0\n[\s\S]*App\.tsx/.test(ls.content)) fail(`ls result: ${ls.content}`);
  if (!secret.is_error || /=/.test(secret.content)) fail(`secret result: ${JSON.stringify(secret)}`);
  if (!/deploy not approved by the user/.test(results(r5)[0].content)) fail(`declined deploy: ${results(r5)[0].content}`);
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

  // New chat clears the log.
  await page.getByRole("button", { name: "New chat" }).click();
  if (await page.locator("#builder-log > *").count()) fail("New chat kept the log");
  // Stop after approving a deploy: the chat says it may still go live, and screen readers hear it.
  requests.length = 0;
  await input.fill("Deploy again");
  await input.press("Enter");
  await approveBtn.click({ timeout: 30000 });
  await page.locator("#builder-log .step", { hasText: "Deploy approved" }).waitFor();
  await page.waitForTimeout(2000); // the deploy finishes; `sleep` keeps the command running
  await page.getByRole("button", { name: "Stop" }).click();
  await page.locator(".notice", { hasText: "may still go live" }).waitFor({ timeout: 10000 });
  if (!(await page.locator("#builder-status").textContent()).includes("may still go live")) fail(`not announced: ${await page.locator("#builder-status").textContent()}`);
  if (!(await page.locator("#builder-working").isHidden())) fail("working indicator stuck");
  console.log("stop after an approved deploy: warned");
  await page.getByRole("button", { name: "New chat" }).click();
  // Forget key goes back to the key form and drops the key.
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
  // Remembered in this browser: a reload keeps the chat closed.
  await page.reload();
  await page.locator("#preview-pane").waitFor();
  if (!(await page.locator("#builder").isHidden())) fail("closed chat not remembered");
  await toggle.click();
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
