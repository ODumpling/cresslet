// Browser e2e: keyboard and focus behavior of the studio (no trap in the terminal or editor, focus survives
// Deploy, Revoke and admin actions, tabs follow the ARIA pattern, no page-level horizontal scroll at 320px).
// Run with the server up (CRESSLET_ADMIN_TOKEN=e2e-admin CRESSLET_SITE_ADMINS=admin@example.com npm run dev): node a11y.ts
import { chromium, type Page } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin";
const call = async (path: string, token: string, body?: object) => (await fetch(base + path, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
})).json();
const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg); };
const focused = (page: Page) => page.evaluate(() => {
  const a = document.activeElement!; // the body at least
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
  for (const r of ["/", "/settings", "/admin", "/admin-credits"]) {
    await narrow.goto(base + r);
    await narrow.waitForTimeout(600);
    const w = await narrow.evaluate(() => document.documentElement.scrollWidth);
    assert(w <= 320, `${r} is ${w}px wide at 320px`);
  }
  // A 40-character app name in the token form's app picker wraps too.
  await narrow.route("**/v1/apps", (r) => r.fulfill({ json: { apps: [{ name: "a".repeat(40), url: "http://x.localhost", updatedAt: new Date().toISOString() }] } }));
  await narrow.goto(base + "/settings");
  await narrow.getByLabel("Only these apps").check();
  await narrow.getByLabel("a".repeat(40)).waitFor();
  const pw = await narrow.evaluate(() => document.documentElement.scrollWidth);
  assert(pw <= 320, `settings app picker is ${pw}px wide at 320px`);
  await narrow.unroute("**/v1/apps");
  // A new token with the longest allowed name, shown in its callout; a long account email in the sidebar.
  await narrow.getByLabel("All apps (and new ones)").check();
  const yName = `${Date.now()}`.padStart(64, "y"); // unique per run, the longest allowed
  await narrow.getByLabel("Name", { exact: true }).fill(yName);
  await narrow.getByRole("button", { name: "Create token" }).click();
  await narrow.locator("#token-new").waitFor({ state: "visible" });
  const tw = await narrow.evaluate(() => document.documentElement.scrollWidth);
  assert(tw <= 320, `new token callout is ${tw}px wide at 320px`);
  // A toast never covers the focused control (WCAG 2.4.11): focus the last control (bottom of the page), then
  // revoke the long-named token without moving focus: its wide "Revoked …" toast would sit right over it.
  narrow.on("dialog", (d) => d.accept());
  await narrow.getByRole("button", { name: "Log out" }).focus();
  await narrow.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await narrow.getByRole("button", { name: `Revoke ${yName}` }).evaluate((b: HTMLElement) => b.click()); // leaves no fixture behind
  await narrow.getByRole("button", { name: `Revoke ${yName}` }).waitFor({ state: "detached" });
  await narrow.waitForTimeout(300);
  const covered = await narrow.evaluate(() => {
    const a = document.activeElement!.getBoundingClientRect(), t = document.getElementById("toast")!.getBoundingClientRect();
    return document.getElementById("toast")!.dataset.open === "true" && a.bottom > t.top && a.top < t.bottom && a.right > t.left && a.left < t.right;
  });
  assert(await focused(narrow) === "logout-btn", "revoking another token moved focus");
  assert(!covered, "the toast covers the focused control");
  // A toast that moved to the top still takes a mouse click on its × (focusing × mustn't move it back down).
  if ((await narrow.locator("#toast").getAttribute("data-top")) !== "true") throw new Error("toast didn't move to the top");
  await narrow.locator("#toast-close").click();
  assert((await narrow.locator("#toast").getAttribute("data-open")) === "false", "clicking × on a top toast didn't close it");
  // A toast that stepped aside (transparent) becomes visible when Tab reaches it.
  await narrow.getByRole("button", { name: "Log out" }).focus();
  await narrow.locator("#token-copy").evaluate((b: HTMLElement) => b.click()); // a toast, focus stays on Log out
  await narrow.locator('#toast[data-open="true"]').waitFor({ state: "attached" }); // copying is async
  await narrow.locator("#toast").evaluate((t) => (t.dataset.top = "hide"));
  await narrow.locator("#toast-close").focus();
  // (its state, not computed opacity: that fades in over 160ms)
  assert(await narrow.locator("#toast").getAttribute("data-top") === "false", "focused toast stayed transparent");
  await narrow.keyboard.press("Escape");
  // A long account email (mocked: no account left behind).
  const lp = await browser.newPage({ viewport: { width: 320, height: 640 } });
  const email = `${"z".repeat(48)}@example.com`;
  await lp.route("**/v1/me", (r) => r.fulfill({ json: { account: { email, github: null, role: null } } }));
  await lp.route("**/v1/apps", (r) => r.fulfill({ json: { apps: [] } }));
  await lp.route("**/v1/me/invites", (r) => r.fulfill({ json: { invites: [] } }));
  await lp.route("**/v1/orgs", (r) => r.fulfill({ json: { orgs: [] } })); // else its 401 logs the mocked token out
  await lp.addInitScript(([e]) => { localStorage.setItem("cresslet.token", "clv_mocked"); localStorage.setItem("cresslet.email", e); }, [email]);
  await lp.goto(base + "/");
  await lp.locator("#account-label").filter({ hasText: "@example.com" }).waitFor();
  const aw = await lp.evaluate(() => document.documentElement.scrollWidth);
  assert(aw <= 320, `home with a long account email is ${aw}px wide at 320px`);
  await lp.close();
  await narrow.close();
  await fetch(`${base}/v1/me/tokens/${encodeURIComponent(long.info.id)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  console.log("reflow ok at 320px (incl. a 64-character token name)");

  const page = await browser.newPage();
  await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);

  // Admin: a failed Delete leaves the button usable; Refresh keeps focus.
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/admin");
  await page.route("**/v1/admin/sites/*", (r) => r.request().method() === "DELETE" ? r.fulfill({ status: 500, body: "{}" }) : r.continue());
  const del = page.getByRole("button", { name: /^Delete / }).first();
  await del.click();
  await page.waitForTimeout(300);
  assert(await del.isEnabled(), "Delete stayed disabled after a failed request");
  await page.unroute("**/v1/admin/sites/*");
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.waitForTimeout(500);
  assert((await page.evaluate(() => document.activeElement!.textContent!.trim())) === "Refresh", "Refresh lost focus");
  console.log("admin focus ok");

  // Settings: after Revoke, focus lands on the list heading.
  await page.goto(base + "/settings");
  await page.getByLabel("Name", { exact: true }).fill("a11y temp");
  // A validation error stays beside the form (not a toast that times out) until the form changes.
  await page.getByLabel("Only these apps").check();
  await page.getByRole("button", { name: "Create token" }).click();
  assert(/Pick at least one app/.test(await page.locator("#token-error").innerText()), "no inline error for an empty app scope");
  await page.getByLabel("All apps (and new ones)").check();
  assert(await page.locator("#token-error").isHidden(), "inline error stayed after fixing the form");
  await page.getByRole("button", { name: "Create token" }).click();
  await page.locator("#token-new").waitFor({ state: "visible" });
  assert(await focused(page) === "token-new-value", "new token value not focused");
  await page.getByRole("button", { name: "Revoke a11y temp" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "tokens-title");
  // Two tokens with the same name (every GitHub login makes one): revoking one must not land on the other's
  // identically labelled button (mocked: nothing changes on the server).
  const dup = await browser.newPage();
  dup.on("dialog", (d) => d.accept());
  let toks = ["t1", "t2"].map((id) => ({ id, name: "Studio (GitHub login)", role: "admin", apps: null, createdAt: new Date().toISOString(), lastUsedAt: null }));
  await dup.route("**/v1/me", (r) => r.fulfill({ json: { account: { email: "dup@example.com", github: null, role: null } } }));
  await dup.route("**/v1/apps", (r) => r.fulfill({ json: { apps: [] } }));
  await dup.route("**/v1/me/tokens", (r) => r.fulfill({ json: { tokens: toks } }));
  await dup.route("**/v1/me/tokens/*", (r) => (toks = toks.filter((t) => !r.request().url().endsWith(`/${t.id}`)), r.fulfill({ json: {} })));
  await dup.addInitScript(() => localStorage.setItem("cresslet.token", "clv_mocked"));
  await dup.goto(base + "/settings");
  await dup.locator("#revoke-t1").focus();
  await dup.keyboard.press("Enter");
  await dup.locator("#revoke-t1").waitFor({ state: "detached" });
  await dup.waitForFunction(() => document.activeElement?.id === "tokens-title");
  await dup.close();
  console.log("settings focus ok");

  // Workspace: tabs, terminal and editor exits, Deploy focus.
  await page.goto(base + "/");
  await page.getByRole("button", { name: /react/ }).click();
  await page.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  // Chat first: the AI builder and the preview; code and terminal on request, and the toggles say what they show.
  assert(await page.locator("#builder").isVisible() && await page.locator("#editor").isHidden() && await page.locator("#drawer").isHidden(), "workspace didn't open chat first");
  const terminalBtn = page.getByRole("button", { name: "Terminal", exact: true });
  await terminalBtn.click();
  assert(await terminalBtn.getAttribute("aria-expanded") === "true", "Terminal toggle not expanded");
  // Dim terminal output (request logs) uses the muted text color, not 50% opacity.
  // ("fetching N packages…" from npm install is always dim)
  const dim = await page.evaluate(() => {
    const d = document.querySelector(".xterm-rows .xterm-dim");
    return d && getComputedStyle(d).color;
  });
  assert(dim, "no dim terminal output to check");
  assert(!/rgba/.test(dim!), `dim terminal text is translucent: ${dim}`);
  await page.getByRole("tab", { name: "Terminal" }).focus();
  await page.keyboard.press("ArrowRight");
  assert(await focused(page) === "tab-deploy-log", "ArrowRight didn't move to the Deploy log tab");
  assert(await page.locator("#deploy-log").isVisible(), "ArrowRight didn't select the Deploy log tab");
  await page.keyboard.press("Home");
  assert(await focused(page) === "tab-terminal", "Home didn't move to the Terminal tab");
  await page.locator(".xterm").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  assert(!(await page.evaluate(() => !!document.activeElement!.closest(".xterm"))), "Esc, Tab didn't leave the terminal");
  const codeBtn = page.getByRole("button", { name: "Code", exact: true });
  await codeBtn.click();
  assert(await codeBtn.getAttribute("aria-pressed") === "true" && await page.locator("#preview-pane").isHidden(), "Code didn't replace the preview");
  // The editor's focus ring must be painted (CodeMirror's layers can cover it): the editor's bottom-left
  // edge (gutter, away from the active line) looks different focused and unfocused.
  const box = (await page.locator("#editor").boundingBox())!; // visible
  const edge = { x: box.x, y: box.y + box.height - 24, width: 3, height: 20 };
  const unfocused = await page.screenshot({ clip: edge });
  await page.locator(".cm-content").click();
  await page.waitForTimeout(100);
  assert(!(await page.screenshot({ clip: edge })).equals(unfocused), "editor focus ring not visible");
  assert(await page.locator("#editor-help").isVisible(), "editor exit hint not shown while the editor has focus");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  assert(!(await page.evaluate(() => !!document.activeElement!.closest(".cm-editor"))), "Esc, Tab didn't leave the editor");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.locator("#preview-path").fill("");
  await page.locator("#preview-path").pressSequentially("/abc");
  assert(await page.locator("#preview-path").inputValue() === "/abc", "can't type in the preview path");
  await page.keyboard.press("Tab");
  assert(await focused(page) !== "preview-path", "Tab didn't leave the preview path");
  console.log("no keyboard traps; tabs ok");
  // First deploy asks for the address: focus starts in it, Escape cancels back to Deploy, Enter deploys.
  await page.locator("#deploy-btn").focus();
  await page.keyboard.press("Enter");
  await page.locator("#deploy-name-status", { hasText: "is available" }).waitFor();
  assert(await focused(page) === "deploy-name", `the deploy dialog focused ${await focused(page)}, not the address`);
  await page.keyboard.press("Escape");
  assert(await focused(page) === "deploy-btn", `cancelling the deploy dialog left focus on ${await focused(page)}`);
  await page.keyboard.press("Enter");
  await page.locator("#deploy-name-status", { hasText: "is available" }).waitFor();
  await page.keyboard.press("Enter");
  await page.locator("#deploy-dialog").waitFor({ state: "hidden" });
  assert(await focused(page) === "deploy-log", `Deploy moved focus to ${await focused(page)}, not the log`);
  await page.locator("#deploy-link").waitFor({ state: "visible", timeout: 60000 });
  console.log("deploy focus ok");

  // Short viewport: preview, chat and editor keep usable height (the drawer is open since Deploy).
  await page.setViewportSize({ width: 1000, height: 300 });
  const tall = (id: string) => page.evaluate((i) => document.getElementById(i)!.getBoundingClientRect().height, id);
  const h = [await tall("preview"), await tall("builder")];
  await page.getByRole("button", { name: "Code", exact: true }).click();
  h.push(await tall("editor"));
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  assert(h.every((x) => x > 100), `panes collapsed at 300px tall: ${h}`);
  console.log("short viewport ok", h);

  // Leaving the workspace reloads the page; focus still lands on the next view's heading.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".topbar-home").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "home-title", null, { timeout: 15000 });
  console.log("focus after leaving the workspace ok");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", (e as Error).message);
} finally {
  await browser.close();
}
