// Browser e2e: studio deploy uploads the project source; "Open source" on the home page restores it.
// Run: start the server with CRESSLET_ADMIN_TOKEN=adm (npm run dev), then: cd tests/e2e && node source.ts
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
  await page.waitForURL(/\/p\//);
  await page.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  await page.locator("#deploy-btn").click();
  await page.locator("#deploy-name-status", { hasText: "is available" }).waitFor(); // keep the generated address
  await page.locator("#deploy-confirm").click();
  await page.locator("#deploy-link").waitFor({ state: "visible", timeout: 60000 });
  const app = new URL((await page.locator("#deploy-link").getAttribute("href"))!).hostname.split(".")[0]; // visible: it has one
  console.log("deployed", app);
  const src = await (await fetch(`${base}/v1/apps/${app}/source`, { headers: { authorization: `Bearer ${acct.token}` } })).json();
  const paths: string[] = src.files.map((f: { path: string }) => f.path);
  if (!paths.includes("src/App.tsx") || paths.some((p) => p.startsWith("node_modules/") || p.startsWith("dist/"))) {
    throw new Error("unexpected source files: " + paths.join(", "));
  }
  console.log("source uploaded:", paths.length, "files");
  const home = await browser.newPage();
  await home.addInitScript((t) => {
    localStorage.setItem("cresslet.token", t);
    localStorage.setItem("cresslet.anthropicKey", "sk-ant-e2e-test"); // the AI builder shows its chat (nothing is sent)
  }, acct.token);
  await home.goto(base + "/");
  const row = home.locator(".list-row", { hasText: app });
  await row.getByRole("button", { name: "Open source" }).click();
  await home.waitForURL(/\/p\//);
  await home.getByRole("button", { name: "Code", exact: true }).click();
  await home.getByRole("button", { name: "Terminal", exact: true }).click();
  await home.locator("#tree").getByText("App.tsx").waitFor({ timeout: 30000 });
  // Imported code doesn't run until the user says so.
  await home.getByRole("button", { name: "Preview", exact: true }).click(); // Run it is in the preview
  await home.getByRole("button", { name: "Run it" }).waitFor({ timeout: 30000 });
  await home.waitForTimeout(1500);
  const termText = await home.locator(".xterm-rows").innerText(); // must be readable
  if ((await home.locator("#preview").getAttribute("src")) || /npm install/.test(termText)) {
    throw new Error("imported source started before Run it");
  }
  if (!(await home.locator("#deploy-btn").isDisabled())) throw new Error("Deploy enabled before Run it (a build runs project CSS plugins)");
  // the terminal takes no input either
  await home.locator(".xterm").click();
  await home.keyboard.type("echo typed-before-consent\n");
  await home.waitForTimeout(1000);
  if (/typed-before-consent/.test(await home.locator(".xterm-rows").innerText())) throw new Error("terminal accepted input before Run it");
  // the AI builder takes a draft, but doesn't send it
  const draft = home.locator("#builder-input");
  await draft.click();
  await home.keyboard.type("rename the heading");
  if ((await draft.inputValue()) !== "rename the heading") throw new Error("AI builder message field didn't take typing before Run it");
  if (!(await home.locator("#builder-send").isDisabled())) throw new Error("AI builder Send enabled before Run it");
  await home.keyboard.press("Enter");
  if ((await draft.inputValue()) !== "rename the heading" || (await home.locator("#builder-log li").count())) throw new Error("AI builder sent before Run it");
  await home.getByRole("button", { name: "Run it" }).click();
  await home.locator("#builder-send:not([disabled])").waitFor({ timeout: 5000 });
  if ((await draft.inputValue()) !== "rename the heading") throw new Error("AI builder draft lost on Run it");
  await home.locator("#deploy-btn:not([disabled])").waitFor({ timeout: 5000 });
  await home.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  // the terminal works again: stop the dev server, run a fresh command
  await home.locator(".xterm").click();
  await home.keyboard.press("Control+C");
  await home.waitForTimeout(500);
  await home.keyboard.type("pwd\n");
  // its output: a line that's just a path (innerText: one line per terminal row)
  for (let i = 0; !/^\/\S+\s*$/m.test(await home.locator(".xterm-rows").innerText()); i++) {
    if (i > 50) throw new Error("terminal input still ignored after Run it");
    await home.waitForTimeout(200);
  }
  console.log("opened deployed source in a new project; preview runs");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", (e as Error).message);
  await page.screenshot({ path: "source-fail.png" });
} finally {
  await browser.close();
}
