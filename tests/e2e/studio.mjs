// Browser e2e: template → in-browser npm install → preview → API → Deploy → live app.
// Run: start the server (npm run dev), then: cd tests/e2e && npm i && npx playwright install chromium && node studio.mjs
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
  // Previews run on their own origin: preview code can't read the studio's storage (API token).
  const { previewOrigin } = await (await fetch(base + "/v1")).json();
  const src = await page.locator("#preview").getAttribute("src");
  if (!previewOrigin || !src.startsWith(previewOrigin)) throw new Error(`preview not on the preview origin: ${src}`);
  await page.evaluate(() => localStorage.setItem("cresslet.token", "clv_acct_studio_secret"));
  const pf = await (await page.locator("#preview").elementHandle()).contentFrame();
  const [origin, seen] = await pf.evaluate(() => [location.origin, localStorage.getItem("cresslet.token")]);
  if (origin !== previewOrigin) throw new Error(`preview frame origin ${origin} ≠ ${previewOrigin}`);
  if (seen !== null) throw new Error("preview could read the studio's token");
  // Sandboxed: no top-level navigation (e.g. to a studio-origin blob: URL) and no popups.
  const before = page.url();
  const [topNav, popup] = await pf.evaluate(() => {
    let t = "blocked";
    try { top.location.href = "/"; t = "tried"; } catch { /* blocked */ }
    let p = "blocked";
    try { if (window.open("/")) p = "opened"; } catch { /* blocked */ }
    return [t, p];
  });
  await page.waitForTimeout(500);
  if (popup !== "blocked" || page.url() !== before || page.context().pages().length !== 1) {
    throw new Error(`preview escaped its sandbox (top: ${topNav}, popup: ${popup}, ${page.url()})`);
  }
  // No "open in new tab": a top-level preview document wouldn't be sandboxed.
  if (await page.locator("#preview-open").count()) throw new Error("raw new-tab preview link is back");
  // A studio-origin blob: URL (what an app worker could mint) can't be loaded into the preview frame
  // with the studio's origin (Chromium partitions blob URLs by storage key).
  const leaked = page.evaluate(() => new Promise((r) => {
    addEventListener("message", (e) => typeof e.data === "string" && e.data.startsWith("token=") && r(e.data));
    setTimeout(() => r(null), 3000);
  }));
  const blob = await page.evaluate(() => URL.createObjectURL(new Blob(
    ["<script>parent.postMessage('token=' + localStorage.getItem('cresslet.token'), '*')</script>"], { type: "text/html" })));
  await Promise.race([pf.evaluate((u) => { location.href = u; }, blob).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  const got = await leaked;
  if (got && got.includes("clv_acct_studio_secret")) throw new Error("studio-origin blob URL ran with the studio's origin inside the preview frame");
  if ((await pf.evaluate(() => location.origin)) !== previewOrigin) throw new Error("preview frame left the preview origin");
  await page.evaluate(() => localStorage.removeItem("cresslet.token"));
  console.log("preview isolated on", previewOrigin);
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
