// Browser e2e: the owner invites an account from the app's Share page; the invitee accepts on the home page,
// then gets what the role allows (admins: Share; viewers: no Share, can Leave). No 320px horizontal scroll.
// Run: start the server with CRESSLET_ADMIN_TOKEN=adm (npm run dev), then: cd tests/e2e && node share.mjs
// SHOTS=<dir> also saves screenshots.
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "adm";
const call = async (path, token, body) => (await fetch(base + path, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
})).json();
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const shot = (page, name) => process.env.SHOTS && page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
const run = Date.now();
const owner = await call("/v1/accounts", admin, { email: `owner-${run}@example.com` });
const invitee = await call("/v1/accounts", admin, { email: `invitee-${run}@example.com` });
const app = `share-${run}`;
await call("/v1/deploys", owner.token, { app, files: [{ path: "index.html", data: "shared" }] });

const browser = await chromium.launch();
const as = async (token, viewport) => {
  const page = await browser.newPage(viewport ? { viewport } : {});
  await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);
  page.on("dialog", (d) => d.accept());
  return page;
};
try {
  // Owner: home → Share → invite as admin.
  const o = await as(owner.token);
  await o.goto(base + "/");
  await o.getByRole("link", { name: `Share ${app}` }).click();
  await o.getByRole("heading", { level: 1, name: new RegExp(`Share ${app}`) }).waitFor();
  await o.getByLabel("Email").fill(invitee.account.email.toUpperCase());
  await o.getByLabel("Role").selectOption("admin");
  await o.getByRole("button", { name: "Send invite" }).click();
  await o.getByRole("button", { name: `Cancel invite for ${invitee.account.email}` }).waitFor();
  assert(await o.locator("#people").getByText("pending").isVisible(), "pending badge");
  await o.getByLabel("Email").fill("not-an-email@x");
  await o.getByRole("button", { name: "Send invite" }).click();
  await o.locator("#invite-error").getByText("valid email required").waitFor();
  await shot(o, "share-pending");
  console.log("owner invited", invitee.account.email);

  // Invitee: accept on home; the app shows up as Admin with Share and Leave.
  const i = await as(invitee.token);
  await i.goto(base + "/");
  await i.getByRole("heading", { name: "Invitations" }).waitFor();
  await shot(i, "home-invite");
  await i.getByRole("button", { name: `Accept invite to ${app}` }).click();
  await i.getByRole("link", { name: `Share ${app}` }).waitFor();
  assert(await i.locator("#invites-section").isHidden(), "invitations hidden once answered");
  const row = i.locator("#apps tr", { hasText: app });
  assert((await row.locator("td").nth(1).textContent()) === "Admin", "access column");
  await shot(i, "home-shared-admin");
  console.log("invitee accepted as admin");

  // Owner: the invitee is now a collaborator; make them a viewer.
  await o.reload();
  const role = o.getByLabel(`Role for ${invitee.account.email}`);
  await role.waitFor();
  await role.selectOption("viewer");
  await o.getByText(`${invitee.account.email} is now viewer`).waitFor();
  await shot(o, "share-collaborator");

  // Invitee as viewer: no Share link (the Share page says why), Leave works.
  await i.reload();
  await i.getByRole("button", { name: `Leave ${app}` }).waitFor();
  assert(!(await i.getByRole("link", { name: `Share ${app}` }).count()), "viewers have no Share link");
  assert((await i.locator("#apps tr", { hasText: app }).locator("td").nth(1).textContent()) === "Viewer", "viewer access");
  await i.goto(`${base}/#/share/${app}`);
  await i.locator("#people").getByText(/can't do that/).waitFor();
  assert(await i.locator("#invite-form").isHidden(), "no invite form for viewers");
  await i.goto(base + "/");
  await i.getByRole("button", { name: `Leave ${app}` }).click();
  await i.getByText(`You left ${app}`).waitFor();
  assert(!(await i.locator("#apps tr", { hasText: app }).count()), "app gone after leaving");
  console.log("viewer left");

  // Reflow: no horizontal page scroll at 320 CSS px on the Share page.
  const narrow = await as(owner.token, { width: 320, height: 640 });
  await narrow.goto(`${base}/#/share/${app}`);
  await narrow.getByRole("heading", { name: "People with access" }).waitFor();
  await narrow.waitForTimeout(300);
  const w = await narrow.evaluate(() => document.documentElement.scrollWidth);
  assert(w <= 320, `share page is ${w}px wide at 320px`);
  await shot(narrow, "share-320");
  console.log("ok");
} finally {
  await browser.close();
}
