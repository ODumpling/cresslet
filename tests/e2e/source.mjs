// Browser e2e: studio deploy uploads the project source; "Open source" on the home page restores it.
// Run: start the server with CRESSLET_ADMIN_TOKEN=adm (npm run dev), then: cd tests/e2e && node source.mjs
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const acct = await (await fetch(`${base}/v1/accounts`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CRESSLET_ADMIN_TOKEN ?? "adm"}`, "content-type": "application/json" },
  body: JSON.stringify({ email: `e2e-${Date.now()}@example.com` }),
})).json();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), acct.token);
try {
  await page.goto(base + "/");
  await page.getByRole("button", { name: /react/ }).click();
  await page.waitForURL(/#\/p\//);
  await page.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  await page.getByRole("button", { name: "Deploy" }).click();
  await page.locator("#deploy-link").waitFor({ state: "visible", timeout: 60000 });
  const app = new URL(await page.locator("#deploy-link").getAttribute("href")).hostname.split(".")[0];
  console.log("deployed", app);
  const src = await (await fetch(`${base}/v1/apps/${app}/source`, { headers: { authorization: `Bearer ${acct.token}` } })).json();
  const paths = src.files.map((f) => f.path);
  if (!paths.includes("src/App.tsx") || paths.some((p) => p.startsWith("node_modules/") || p.startsWith("dist/"))) {
    throw new Error("unexpected source files: " + paths.join(", "));
  }
  console.log("source uploaded:", paths.length, "files");
  const home = await browser.newPage();
  await home.addInitScript((t) => localStorage.setItem("cresslet.token", t), acct.token);
  await home.goto(base + "/");
  const row = home.locator(".list-row", { hasText: app });
  await row.getByRole("button", { name: "Open source" }).click();
  await home.waitForURL(/#\/p\//);
  await home.locator("#tree").getByText("App.tsx").waitFor({ timeout: 30000 });
  // Imported code doesn't run until the user says so.
  await home.getByRole("button", { name: "Run it" }).waitFor({ timeout: 30000 });
  await home.waitForTimeout(1500);
  const termText = await home.locator(".xterm-rows").innerText(); // must be readable
  if ((await home.locator("#preview").getAttribute("src")) || /npm install/.test(termText)) {
    throw new Error("imported source started before Run it");
  }
  if (!(await home.locator("#deploy-btn").isDisabled())) throw new Error("Deploy enabled before Run it (a build runs project CSS plugins)");
  await home.getByRole("button", { name: "Run it" }).click();
  await home.locator("#deploy-btn:not([disabled])").waitFor({ timeout: 5000 });
  await home.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  console.log("opened deployed source in a new project; preview runs");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", e.message);
  await page.screenshot({ path: "source-fail.png" });
} finally {
  await browser.close();
}
