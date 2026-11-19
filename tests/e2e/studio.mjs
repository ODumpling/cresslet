// Browser e2e: template → in-browser npm install → preview → API → Deploy → live app.
// Run: start the server (deno task dev), then: cd tests/e2e && npm i && npx playwright install chromium && node studio.mjs
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
try {
  await page.goto(base + "/");
  await page.getByRole("button", { name: /react/ }).click();
  await page.waitForURL(/#\/p\//);
  const frame = page.frameLocator("#preview");
  await frame.getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  console.log("preview rendered");
  await frame.getByPlaceholder("Add a todo").fill("from studio");
  await frame.getByRole("button", { name: "Add" }).click();
  await frame.getByText("from studio").waitFor({ timeout: 15000 });
  console.log("api + sql.js works");
  await page.getByRole("button", { name: "Deploy" }).click();
  await page.locator("#deploy-link").waitFor({ state: "visible", timeout: 60000 });
  const url = await page.locator("#deploy-link").getAttribute("href");
  console.log("deployed", url);
  console.log(await page.locator("#deploy-log").textContent());
  const p2 = await browser.newPage();
  await p2.goto(url);
  await p2.getByRole("heading", { name: "Todos" }).waitFor({ timeout: 15000 });
  await p2.getByPlaceholder("Add a todo").fill("on cresslet");
  await p2.getByRole("button", { name: "Add" }).click();
  await p2.getByText("on cresslet").waitFor({ timeout: 15000 });
  console.log("deployed app works");
  await page.screenshot({ path: (process.argv[2] ?? ".") + "/studio.png" });
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", e.message);
  await page.screenshot({ path: (process.argv[2] ?? ".") + "/studio-fail.png" });
  console.log(await page.locator(".xterm-rows").innerText().catch(() => ""));
} finally {
  console.log(logs.slice(-30).join("\n"));
  await browser.close();
}
