// Browser e2e: Settings → page defaults; home → upload an HTML file (generated address) and a folder (its own address;
// defaults prefilled, overridable);
// change a page's visibility and retention in its row; replace a page with a folder; a private page opens through the studio's sign-in hop,
// and a stranger is told they have no access. No 320px horizontal scroll.
// Run: start the server with CRESSLET_ADMIN_TOKEN=adm (npm run dev), then: cd tests/e2e && node pages.mjs
// SHOTS=<dir> also saves screenshots.
import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "adm";
const call = async (path, token, body, method = body ? "POST" : "GET") => (await fetch(base + path, {
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
})).json();
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const shot = (page, name) => process.env.SHOTS && page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
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
const as = async (token, viewport) => {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  await ctx.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  return page;
};
try {
  // Settings: defaults start at the server's; save link-only, kept 7 days.
  const o = await as(owner.token);
  await o.goto(base + "/#/settings");
  await o.getByLabel("Who can open new pages").waitFor();
  await o.waitForFunction(() => document.getElementById("def-server").textContent !== "—");
  assert(await o.getByLabel("Who can open new pages").inputValue() === "private", "server default visibility");
  assert(await o.getByLabel("Keep new pages for").inputValue() === "30", "server default retention");
  await o.getByLabel("Who can open new pages").selectOption("link");
  await o.getByLabel("Keep new pages for").selectOption("7");
  await o.getByRole("button", { name: "Save defaults" }).click();
  await o.getByText("Page defaults saved").waitFor();
  const saved = await call("/v1/me/settings", owner.token);
  assert(saved.pages.visibility === "link" && saved.pages.retentionDays === 7, `saved ${JSON.stringify(saved.pages)}`);
  await shot(o, "pages-settings");

  // Home: the form starts at the account's defaults; upload a file with them.
  await o.goto(base + "/#/pages");
  await o.getByRole("heading", { name: "Pages", exact: true }).waitFor();
  await o.waitForFunction(() => document.getElementById("page-retention").value === "7");
  assert(await o.getByLabel("Who can open it").inputValue() === "link", "form default visibility");
  await o.getByRole("button", { name: "Upload" }).click();
  await o.getByText("Choose an HTML file or a folder first.").waitFor();
  await o.locator("#page-file").setInputFiles(join(dir, "report.html"));
  await o.getByText("report.html").waitFor();
  // Its address: a generated unguessable one unless changed.
  await o.locator("#page-name-status", { hasText: "is available" }).waitFor();
  const generated = await o.getByRole("textbox", { name: "Address" }).inputValue();
  assert(/^pg-[0-9a-f]{20}$/.test(generated), `generated page name ${generated}`);
  await o.getByRole("button", { name: "Upload" }).click();
  await o.getByText(/^Uploaded report:/).waitFor();
  let pages = (await call("/v1/pages", owner.token)).pages;
  assert(pages.length === 1 && pages[0].name === generated && pages[0].title === "report" && pages[0].visibility === "link" && pages[0].retentionDays === 7, `upload 1 ${JSON.stringify(pages)}`);
  const report = pages[0];
  const r = await fetch(report.url, { redirect: "manual" });
  assert(r.status === 200 && (await r.text()).includes("Quarterly report"), "link page serves");

  // A folder, overriding the defaults: public, forever. Hidden files stay behind.
  await o.locator("#page-dir").setInputFiles(join(dir, "site"));
  await o.getByText("site/ (2 files)").waitFor();
  await o.getByLabel("Who can open it").selectOption("public");
  await o.getByLabel("Keep for", { exact: true }).selectOption("forever");
  // A name of your own: a taken one is refused before uploading, a free one is the page's address.
  const address = o.getByRole("textbox", { name: "Address" });
  await o.locator("#page-name-status", { hasText: "is available" }).waitFor();
  assert(await address.inputValue() !== generated, "a new address for the next page");
  await address.fill(generated);
  await o.locator("#page-name-status", { hasText: `${generated} is taken` }).waitFor();
  await o.getByRole("button", { name: "Upload" }).click();
  assert(await o.evaluate(() => document.activeElement?.id) === "page-name", "upload to a taken name didn't return to the address");
  const custom = `site-${run.toString(36)}`;
  await address.fill(custom);
  await o.locator("#page-name-status", { hasText: `${custom} is available` }).waitFor();
  await shot(o, "pages-custom-name");
  await o.getByRole("button", { name: "Upload" }).click();
  await o.getByText(/^Uploaded site:/).waitFor();
  pages = (await call("/v1/pages", owner.token)).pages;
  const site = pages.find((p) => p.title === "site");
  assert(site?.name === custom && site.url.includes(`//${custom}.`), `custom page name ${JSON.stringify(site)}`);
  assert(site && site.visibility === "public" && site.retentionDays === null && site.files === 2, `upload 2 ${JSON.stringify(site)}`);
  assert((await fetch(site.url + "/img/dot.svg")).status === 200, "folder asset serves");
  assert(await o.getByLabel("Who can open it").inputValue() === "link", "form back to defaults after upload");

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
  await s.getByText(/You don't have access to this page/).waitFor();
  await shot(s, "pages-no-access");
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(report.url);
  await anon.locator("#view").getByRole("button", { name: "Log in with GitHub" }).waitFor();
  assert(anon.url().startsWith(base + "/#/view/"), `anon at ${anon.url()}`);

  // Replace a page with a folder: same link, all its files swapped; a missing page there is a 404, not the index.
  await o.goto(base + "/#/pages");
  await o.getByLabel("Replace report with a folder").setInputFiles(join(dir, "site"));
  await o.getByText("Replaced report (same link)").waitFor();
  const replaced = (await call(`/v1/pages/${report.name}`, owner.token)).page;
  assert(replaced.name === report.name && replaced.files === 2, `replace ${JSON.stringify(replaced)}`);
  await o.goto(report.url + "/img/dot.svg");
  await o.goto(report.url + "/");
  await o.getByRole("heading", { name: "Folder site" }).waitFor();
  assert((await o.goto(report.url + "/no-such-page")).status() === 404, "broken link is a 404");

  // Delete.
  await o.goto(base + "/#/pages");
  await o.getByRole("button", { name: "Delete site" }).click();
  await o.getByText("Deleted site").waitFor();
  assert((await fetch(site.url)).status === 404, "deleted page 404s");

  // Phone width: no horizontal scroll.
  const narrow = await as(owner.token, { width: 320, height: 700 });
  await narrow.goto(base + "/#/pages");
  await narrow.getByRole("heading", { name: "Pages", exact: true }).waitFor();
  await narrow.getByLabel("Who can open report").waitFor();
  for (const hash of ["#/", "#/pages", "#/settings"]) {
    await narrow.goto(base + "/" + hash);
    await narrow.waitForTimeout(300);
    const over = await narrow.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(over <= 0, `${hash} scrolls sideways at 320px (${over}px)`);
  }
  await shot(narrow, "pages-320");
  console.log("pages e2e ok");
} finally {
  await browser.close();
}
