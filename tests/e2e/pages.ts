// Browser e2e: Settings → page defaults; Artifacts → New artifact (a dialog) → upload an HTML file (generated address)
// and a folder (its own address; defaults prefilled, overridable);
// change a page's visibility and retention in its row; replace a page with a folder (its row's menu); a private page opens through the studio's sign-in hop,
// and a stranger is told they have no access. No 320px horizontal scroll.
// Run: start the server with CRESSLET_ADMIN_TOKEN=adm (npm run dev), then: cd tests/e2e && node pages.ts
// SHOTS=<dir> also saves screenshots.
import { chromium, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "adm";
const call = async (path: string, token: string, body?: object, method = body ? "POST" : "GET") => (await fetch(base + path, {
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
})).json();
const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg); };
const shot = (page: Page, name: string) => process.env.SHOTS && page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
const run = Date.now();
const owner = await call("/v1/accounts", admin, { email: `pages-${run}@example.com` });
const stranger = await call("/v1/accounts", admin, { email: `stranger-${run}@example.com` });
const dir = await mkdtemp(join(tmpdir(), "cresslet-pages-e2e-"));
await writeFile(join(dir, "report.html"), "<!doctype html><title>Report</title><h1>Quarterly report</h1>");
await mkdir(join(dir, "site/img"), { recursive: true });
await writeFile(join(dir, "site/index.html"), '<!doctype html><h1>Folder site</h1><img src="img/dot.svg" alt="dot">');
await writeFile(join(dir, "site/img/dot.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="4"/></svg>');
await writeFile(join(dir, "site/.DS_Store"), "junk");

const browser = await chromium.launch();
const as = async (token: string, viewport?: { width: number; height: number }) => {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  await ctx.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  return page;
};
try {
  // Settings: defaults start at the server's; save link-only, kept 7 days.
  const o = await as(owner.token);
  await o.goto(base + "/settings");
  await o.getByLabel("Who can open new artifacts").waitFor();
  await o.waitForFunction(() => document.getElementById("def-server")!.textContent !== "—");
  assert(await o.getByLabel("Who can open new artifacts").inputValue() === "private", "server default visibility");
  assert(await o.getByLabel("Keep new artifacts for").inputValue() === "30", "server default retention");
  await o.getByLabel("Who can open new artifacts").selectOption("link");
  await o.getByLabel("Keep new artifacts for").selectOption("7");
  await o.getByRole("button", { name: "Save defaults" }).click();
  await o.getByText("Artifact defaults saved").waitFor();
  const saved = await call("/v1/me/settings", owner.token);
  assert(saved.pages.visibility === "link" && saved.pages.retentionDays === 7, `saved ${JSON.stringify(saved.pages)}`);
  await shot(o, "pages-settings");

  // The list, then the New artifact dialog: it starts at the account's defaults; Cancel closes it; upload a file with them.
  await o.goto(base + "/pages");
  await o.getByRole("heading", { name: "Artifacts", exact: true }).waitFor();
  await o.getByText("No artifacts yet").waitFor();
  const dialog = o.getByRole("dialog", { name: "New artifact" });
  await o.getByRole("button", { name: "New artifact" }).first().click();
  await dialog.waitFor();
  await o.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  // Its Settings link leaves the page, and the dialog doesn't come along.
  await o.getByRole("button", { name: "New artifact" }).first().click();
  await dialog.getByRole("link", { name: "Settings" }).click();
  await o.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  assert(!await dialog.isVisible(), "dialog stayed open over Settings");
  await o.goto(base + "/artifacts");
  await o.getByRole("button", { name: "New artifact" }).first().click();
  await dialog.waitFor();
  assert(await o.locator("#page-retention").inputValue() === "7", "dialog opened before the account's defaults");
  assert(await o.getByLabel("Who can open it").inputValue() === "link", "form default visibility");
  await o.getByRole("button", { name: "Deploy" }).click();
  await o.getByText("Choose an HTML file or a folder first.").waitFor();
  await o.locator("#page-file").setInputFiles(join(dir, "report.html"));
  await o.getByText("report.html", { exact: true }).waitFor();
  // Its address: a generated unguessable one unless changed.
  await o.locator("#page-name-status", { hasText: "is available" }).waitFor();
  const generated = await o.getByRole("textbox", { name: "Address" }).inputValue();
  assert(/^pg-[0-9a-f]{20}$/.test(generated), `generated page name ${generated}`);
  await o.getByRole("button", { name: "Deploy" }).click();
  await o.getByText(/^Deployed report:/).waitFor();
  let pages = (await call("/v1/pages", owner.token)).pages;
  assert(pages.length === 1 && pages[0].name === generated && pages[0].title === "report" && pages[0].visibility === "link" && pages[0].retentionDays === 7, `upload 1 ${JSON.stringify(pages)}`);
  const report = pages[0];
  const r = await fetch(report.url, { redirect: "manual" });
  assert(r.status === 200 && (await r.text()).includes("Quarterly report"), "link page serves");

  await dialog.waitFor({ state: "hidden" });

  // A folder, overriding the defaults: public, forever. Hidden files stay behind.
  await o.getByRole("button", { name: "New artifact" }).click();
  await dialog.waitFor();
  await o.locator("#page-dir").setInputFiles(join(dir, "site"));
  await o.getByText("site/", { exact: true }).waitFor();
  await o.getByText("2 files", { exact: true }).waitFor();
  await o.getByLabel("Who can open it").selectOption("public");
  await o.getByLabel("Keep for", { exact: true }).selectOption("forever");
  // A name of your own: a taken one is refused before uploading, a free one is the page's address.
  const address = o.getByRole("textbox", { name: "Address" });
  await o.locator("#page-name-status", { hasText: "is available" }).waitFor();
  assert(await address.inputValue() !== generated, "a new address for the next page");
  await address.fill(generated);
  await o.locator("#page-name-status", { hasText: `${generated} is taken` }).waitFor();
  await o.getByRole("button", { name: "Deploy" }).click();
  assert(await o.evaluate(() => document.activeElement?.id) === "page-name", "upload to a taken name didn't return to the address");
  const custom = `site-${run.toString(36)}`;
  await address.fill(custom);
  await o.locator("#page-name-status", { hasText: `${custom} is available` }).waitFor();
  await shot(o, "pages-custom-name");
  await o.getByRole("button", { name: "Deploy" }).click();
  await o.getByText(/^Deployed site:/).waitFor();
  pages = (await call("/v1/pages", owner.token)).pages;
  const site = pages.find((p: { title: string | null }) => p.title === "site");
  assert(site?.name === custom && site.url.includes(`//${custom}.`), `custom page name ${JSON.stringify(site)}`);
  assert(site && site.visibility === "public" && site.retentionDays === null && site.files === 2, `upload 2 ${JSON.stringify(site)}`);
  assert((await fetch(site.url + "/img/dot.svg")).status === 200, "folder asset serves");
  await o.getByRole("button", { name: "New artifact" }).click();
  await dialog.waitFor();
  assert(await o.getByLabel("Who can open it").inputValue() === "link", "form back to defaults after upload");
  assert(await o.getByText("Nothing chosen").isVisible(), "no file picked in a new dialog");
  await o.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  // Row controls: make the report private, keep it 90 days.
  await o.getByLabel("Who can open report").selectOption("private");
  await o.getByText("report: private").waitFor();
  await o.getByLabel("Keep report for").selectOption("90");
  await o.getByText(/report is kept until/).waitFor();
  const changed = (await call(`/v1/pages/${report.name}`, owner.token)).page;
  assert(changed.visibility === "private" && changed.retentionDays === 90, `row change ${JSON.stringify(changed)}`);
  assert((await fetch(report.url, { redirect: "manual" })).status === 302, "private page redirects without a session");
  await shot(o, "pages-home");

  // Opening the private page: page → studio → one-time ticket → page (cookie), then directly.
  await o.goto(report.url + "/?from=e2e");
  await o.getByRole("heading", { name: "Quarterly report" }).waitFor();
  assert(new URL(o.url()).search === "?from=e2e", `ticket left in URL: ${o.url()}`);
  await o.reload();
  await o.getByRole("heading", { name: "Quarterly report" }).waitFor();
  console.log("private page opens for its owner");

  // A stranger, logged in, lands on the studio's explanation; logged out, on a login prompt.
  const s = await as(stranger.token);
  await s.goto(report.url);
  await s.getByText(/You don't have access to this artifact/).waitFor();
  await shot(s, "pages-no-access");
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(report.url);
  await anon.locator("#view").getByRole("button", { name: "Log in with GitHub" }).waitFor();
  assert(anon.url().startsWith(base + "/view/"), `anon at ${anon.url()}`);
  // Logged out: the landing page links to artifacts, which ask for a login; they stay in the nav; the old /#/pages
  // address (from when routes were hashes) goes to /artifacts.
  await anon.goto(base + "/");
  await anon.locator("#landing").getByRole("link", { name: "artifact", exact: true }).click();
  await anon.getByText("Log in to deploy artifacts").waitFor();
  await anon.goto(base + "/#/pages");
  await anon.getByText("Log in to deploy artifacts").waitFor();
  assert(anon.url() === base + "/artifacts", `old address at ${anon.url()}`);
  assert(await anon.getByRole("link", { name: "Artifacts" }).isVisible(), "Artifacts in the nav when logged out");
  assert(!await anon.locator("#page-form").isVisible(), "no form when logged out");
  // Sharing an artifact describes what its roles can do with it, not an app's logs and secrets.
  await o.goto(base + "/share/" + report.name);
  await o.getByRole("heading", { name: /Share report/ }).waitFor();
  await o.locator("#invite-role").waitFor();
  assert(/open it, even when it's private/.test((await o.locator("#invite-role option[value=viewer]").textContent())!), "artifact viewer role text");

  // Replace a page with a folder: same link, all its files swapped; a missing page there is a 404, not the index.
  await o.goto(base + "/pages");
  await o.getByRole("button", { name: "More actions for report" }).click();
  const [chooser] = await Promise.all([
    o.waitForEvent("filechooser"),
    o.getByRole("button", { name: /^Replace with a folder/ }).click(),
  ]);
  await chooser.setFiles(join(dir, "site"));
  await o.getByText("Replaced report (same link)").waitFor();
  const replaced = (await call(`/v1/pages/${report.name}`, owner.token)).page;
  assert(replaced.name === report.name && replaced.files === 2, `replace ${JSON.stringify(replaced)}`);
  await o.goto(report.url + "/img/dot.svg");
  await o.goto(report.url + "/");
  await o.getByRole("heading", { name: "Folder site" }).waitFor();
  assert((await o.goto(report.url + "/no-such-page"))!.status() === 404, "broken link is a 404");

  // Delete.
  await o.goto(base + "/pages");
  await o.getByRole("button", { name: "More actions for site" }).click();
  await o.getByRole("button", { name: "Delete site" }).click();
  await o.getByText("Deleted site").waitFor();
  assert((await fetch(site.url)).status === 404, "deleted page 404s");

  // Phone width: no horizontal scroll.
  const narrow = await as(owner.token, { width: 320, height: 700 });
  await narrow.goto(base + "/pages");
  await narrow.getByRole("heading", { name: "Artifacts", exact: true }).waitFor();
  await narrow.getByLabel("Who can open report").waitFor();
  for (const path of ["/", "/pages", "/settings"]) {
    await narrow.goto(base + path);
    await narrow.waitForTimeout(300);
    const over = await narrow.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(over <= 0, `${path} scrolls sideways at 320px (${over}px)`);
  }
  await shot(narrow, "pages-320");
  console.log("pages e2e ok");
} finally {
  await browser.close();
}
