// Browser e2e: keyboard and focus behavior of the studio (no trap in the terminal or editor, focus survives
// Deploy, Revoke and admin actions, tabs follow the ARIA pattern, no page-level horizontal scroll at 320px).
// Run with the server up (CRESSLET_ADMIN_TOKEN=e2e-admin CRESSLET_SITE_ADMINS=admin@example.com npm run dev): node a11y.mjs
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin";
const call = async (path, token, body) => (await fetch(base + path, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
})).json();
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a === document.body ? "body" : a.id || a.getAttribute("aria-label") || a.className || a.tagName;
});
const browser = await chromium.launch();
try {
  const { token } = await call("/v1/accounts", admin, { email: "admin@example.com" });
  await call("/v1/deploys", token, { files: [{ path: "index.html", data: "a11y" }] });
  const longName = "x".repeat(64); // the longest token name the form allows
  const long = await call("/v1/me/tokens", token, { name: longName, role: "read", apps: null });

  // Reflow: no horizontal page scroll at 320 CSS px.
  const narrow = await browser.newPage({ viewport: { width: 320, height: 640 } });
  await narrow.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);
  for (const r of ["/", "/#/settings", "/#/admin"]) {
    await narrow.goto(base + r);
    await narrow.waitForTimeout(600);
    const w = await narrow.evaluate(() => document.documentElement.scrollWidth);
    assert(w <= 320, `${r} is ${w}px wide at 320px`);
  }
  await narrow.close();
  await fetch(`${base}/v1/me/tokens/${encodeURIComponent(long.info.id)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  console.log("reflow ok at 320px (incl. a 64-character token name)");

  const page = await browser.newPage();
  await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);

  // Admin: a failed Delete leaves the button usable; Refresh keeps focus.
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/#/admin");
  await page.route("**/v1/admin/sites/*", (r) => r.request().method() === "DELETE" ? r.fulfill({ status: 500, body: "{}" }) : r.continue());
  const del = page.getByRole("button", { name: /^Delete / }).first();
  await del.click();
  await page.waitForTimeout(300);
  assert(await del.isEnabled(), "Delete stayed disabled after a failed request");
  await page.unroute("**/v1/admin/sites/*");
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.waitForTimeout(500);
  assert((await page.evaluate(() => document.activeElement.textContent.trim())) === "Refresh", "Refresh lost focus");
  console.log("admin focus ok");

  // Settings: after Revoke, focus lands on the list heading.
  await page.goto(base + "/#/settings");
  await page.getByLabel("Name", { exact: true }).fill("a11y temp");
  await page.getByRole("button", { name: "Create token" }).click();
  await page.locator("#token-new").waitFor({ state: "visible" });
  assert(await focused(page) === "token-new-value", "new token value not focused");
  await page.getByRole("button", { name: "Revoke a11y temp" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "tokens-title");
  console.log("settings focus ok");

  // Workspace: tabs, terminal and editor exits, Deploy focus.
  await page.goto(base + "/");
  await page.getByRole("button", { name: /react/ }).click();
  await page.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  await page.getByRole("tab", { name: "Terminal" }).focus();
  await page.keyboard.press("ArrowRight");
  assert(await focused(page) === "tab-deploy-log", "ArrowRight didn't move to the Deploy log tab");
  assert(await page.locator("#deploy-log").isVisible(), "ArrowRight didn't select the Deploy log tab");
  await page.keyboard.press("Home");
  assert(await focused(page) === "tab-terminal", "Home didn't move to the Terminal tab");
  await page.locator(".xterm").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  assert(!(await page.evaluate(() => !!document.activeElement.closest(".xterm"))), "Esc, Tab didn't leave the terminal");
  // The editor's focus ring must be painted (CodeMirror's layers can cover it): the editor's bottom-left
  // edge (gutter, away from the active line) looks different focused and unfocused.
  const box = await page.locator("#editor").boundingBox();
  const edge = { x: box.x, y: box.y + box.height - 24, width: 3, height: 20 };
  const unfocused = await page.screenshot({ clip: edge });
  await page.locator(".cm-content").click();
  await page.waitForTimeout(100);
  assert(!(await page.screenshot({ clip: edge })).equals(unfocused), "editor focus ring not visible");
  assert(await page.locator("#editor-help").isVisible(), "editor exit hint not shown while the editor has focus");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  assert(!(await page.evaluate(() => !!document.activeElement.closest(".cm-editor"))), "Esc, Tab didn't leave the editor");
  await page.locator("#preview-path").fill("");
  await page.locator("#preview-path").pressSequentially("/abc");
  assert(await page.locator("#preview-path").inputValue() === "/abc", "can't type in the preview path");
  await page.keyboard.press("Tab");
  assert(await focused(page) !== "preview-path", "Tab didn't leave the preview path");
  console.log("no keyboard traps; tabs ok");
  await page.locator("#deploy-btn").focus();
  await page.keyboard.press("Enter");
  assert(await focused(page) === "deploy-log", `Deploy moved focus to ${await focused(page)}, not the log`);
  await page.locator("#deploy-link").waitFor({ state: "visible", timeout: 60000 });
  console.log("deploy focus ok");

  // Short viewport: editor and preview keep usable height.
  await page.setViewportSize({ width: 1000, height: 300 });
  const h = await page.evaluate(() => ["editor", "preview"].map((id) => document.getElementById(id).getBoundingClientRect().height));
  assert(h.every((x) => x > 100), `panes collapsed at 300px tall: ${h}`);
  console.log("short viewport ok", h);
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", e.message);
} finally {
  await browser.close();
}
