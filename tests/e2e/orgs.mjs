// Browser e2e for account management (#/admin-users), organizations (#/admin-orgs, #/orgs/<name>) and moving an
// app into one (its Share page). Run the server with an admin token:
//   CRESSLET_ADMIN_TOKEN=e2e-admin npm run dev
// then: cd tests/e2e && npm i && node orgs.mjs [outdir]
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin";
const out = process.argv[2] ?? ".";
const fail = (m) => { throw new Error(m); };

const call = async (path, token, body, method = body ? "POST" : "GET") => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return r.json();
};
const stamp = Date.now();
const bossEmail = `boss-${stamp}@example.com`, devEmail = `dev-${stamp}@example.com`, newEmail = `new-${stamp}@example.com`;
const boss = await call("/v1/accounts", admin, { email: bossEmail });
const dev = await call("/v1/accounts", admin, { email: devEmail });
await call("/v1/admin/accounts/role", admin, { email: bossEmail, role: "SiteAdmin" }, "PUT");
const app = `e2e-org-${stamp}`;
await call("/v1/deploys", dev.token, { app, files: [{ path: "index.html", data: "<h1>hi</h1>" }] });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const logs = [];
const open = async (token) => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);
  return page;
};
try {
  // ---- site admin: Users
  let page = await open(boss.token);
  await page.goto(base + "/");
  await page.getByRole("link", { name: "Users" }).click();
  await page.waitForURL(/#\/admin-users$/);
  await page.getByRole("heading", { name: "Users", level: 1 }).waitFor();
  if ((await page.getByRole("link", { name: "Users" }).getAttribute("aria-current")) !== "page") fail("Users nav link not current");
  const table = page.getByRole("region", { name: "Accounts table" });
  const row = (email) => table.locator("tbody tr", { hasText: email });
  await row(devEmail).waitFor();
  await page.locator("main:not([hidden])").getByLabel("Email").fill(newEmail);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await row(newEmail).getByText("Invited", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/admin-users.png`, fullPage: true });
  await row(devEmail).getByRole("button", { name: `Disable ${devEmail}` }).click();
  await row(devEmail).getByText("Disabled", { exact: true }).waitFor();
  if ((await call("/v1/me", dev.token)).account) fail("disabled account's token still works");
  await row(devEmail).getByRole("button", { name: `Enable ${devEmail}` }).click();
  await row(devEmail).getByText("Active", { exact: true }).waitFor();
  await row(newEmail).getByRole("button", { name: `Withdraw the invite for ${newEmail}` }).click();
  await row(newEmail).waitFor({ state: "detached" });

  // ---- site admin: Organizations
  await page.getByRole("link", { name: "Organizations" }).last().click();
  await page.waitForURL(/#\/admin-orgs$/);
  await page.locator("main:not([hidden])").getByLabel("Name", { exact: true }).fill(`acme-${stamp}`);
  await page.locator("main:not([hidden])").getByLabel("Display name (optional)").fill(`Acme ${stamp}`);
  await page.locator("main:not([hidden])").getByLabel("First admin (optional)").fill(devEmail);
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.getByRole("link", { name: `Acme ${stamp}` }).waitFor();
  await page.screenshot({ path: `${out}/admin-orgs.png`, fullPage: true });
  await page.close();

  // ---- the org admin: Share page → move the app in, then the org page
  const dev2 = await call("/v1/accounts", admin, { email: devEmail }); // its tokens went when it was disabled
  page = await open(dev2.token);
  await page.goto(`${base}/#/share/${app}`);
  await page.getByRole("heading", { name: "Organization" }).waitFor();
  await page.locator("main:not([hidden])").getByLabel("Belongs to").selectOption(`acme-${stamp}`);
  await page.getByRole("button", { name: "Move" }).click();
  await page.getByText("Organization: its admins own this").waitFor();
  await page.screenshot({ path: `${out}/share-org.png`, fullPage: true });
  await page.getByRole("link", { name: "Organizations" }).first().click();
  await page.waitForURL(/#\/orgs$/);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/orgs-list.png`, fullPage: true });
  await page.getByRole("link", { name: `Acme ${stamp}` }).click();
  await page.getByRole("heading", { name: "Members (1)" }).waitFor();
  await page.getByRole("link", { name: app }).waitFor();
  await page.locator("main:not([hidden])").getByLabel("Email").fill(bossEmail);
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByRole("heading", { name: "Members (2)" }).waitFor();
  await page.screenshot({ path: `${out}/org.png`, fullPage: true });
  const access = (await call(`/v1/apps/${app}`, boss.token)).app?.access;
  if (access !== "admin") fail(`a member's access to an org app: ${access}`);
  if (logs.length) fail(logs.join("\n"));
  console.log("orgs e2e: ok");
} finally {
  await browser.close();
}
