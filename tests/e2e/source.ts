// Browser e2e: studio deploy uploads the project source; "Open in studio" on the home page restores it, running.
// Run: start the server with CRESSLET_ADMIN_TOKEN=adm (npm run dev), then: cd tests/e2e && node source.ts
import { chromium } from "@playwright/test";
import { studioMode } from "./studio-mode.ts";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const acct = await (await fetch(`${base}/v1/accounts`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CRESSLET_ADMIN_TOKEN ?? "adm"}`, "content-type": "application/json" },
  body: JSON.stringify({ email: `e2e-${Date.now()}@example.com` }),
})).json();
const browser = await chromium.launch();
studioMode(browser);
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
  await row.getByRole("button", { name: "Open in studio" }).click();
  await home.waitForURL(/\/p\//);
  await home.getByRole("button", { name: "Code", exact: true }).click();
  await home.getByRole("button", { name: "Terminal", exact: true }).click();
  await home.locator("#tree").getByText("App.tsx").waitFor({ timeout: 30000 });
  // It runs as it opens: dependencies installed, the dev server started, nothing to click first.
  await home.getByRole("button", { name: "Preview", exact: true }).click();
  await home.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  await home.locator("#deploy-btn:not([disabled])").waitFor({ timeout: 5000 });
  await home.locator("#builder-send:not([disabled])").waitFor({ timeout: 5000 }); // the AI builder sends
  // the terminal takes input: stop the dev server, run a fresh command
  await home.locator(".xterm").click();
  await home.keyboard.press("Control+C");
  await home.waitForTimeout(500);
  await home.keyboard.type("pwd\n");
  // its output: a line that's just a path (innerText: one line per terminal row)
  for (let i = 0; !/^\/\S+\s*$/m.test(await home.locator(".xterm-rows").innerText()); i++) {
    if (i > 50) throw new Error("terminal input ignored");
    await home.waitForTimeout(200);
  }
  // The project's code runs as it opens, so `cresslet deploy` in the terminal (a script's or typed) asks first: typing
  // deploy lets it through.
  home.once("dialog", (d) => void d.accept("deploy"));
  await home.keyboard.type("cresslet deploy\n");
  for (let i = 0; !new RegExp(`deployed ${app} →`).test(await home.locator(".xterm-rows").innerText()); i++) {
    if (i > 300) throw new Error("terminal deploy with deploy typed didn't deploy");
    await home.waitForTimeout(200);
  }
  let asked = "";
  // A stray Enter (the prompt's default, empty) refuses it.
  home.once("dialog", (d) => (asked = `${d.type()}: ${d.message()}`, void d.accept("")));
  await home.keyboard.type("cresslet deploy\n");
  for (let i = 0; !/deploy not confirmed by the user/.test(await home.locator(".xterm-rows").innerText()); i++) {
    if (i > 100) throw new Error(`terminal deploy wasn't refused (asked: ${JSON.stringify(asked)})`);
    await home.waitForTimeout(200);
  }
  if (!asked.startsWith("prompt:") || !asked.includes(`deploy to ${app}`)) throw new Error(`asked: ${asked}`);
  // Declined once: the next one is refused without asking (a stray Enter can't accept a later one).
  let again = false;
  home.once("dialog", (d) => (again = true, void d.accept("deploy")));
  await home.keyboard.type("cresslet deploy\n");
  for (let i = 0; ((await home.locator(".xterm-rows").innerText()).match(/deploy not confirmed by the user/g) ?? []).length < 2; i++) {
    if (i > 100) throw new Error("second terminal deploy wasn't refused");
    await home.waitForTimeout(200);
  }
  if (again) throw new Error("asked again after a decline");
  console.log("opened deployed source in a new project; preview runs; a terminal deploy asks first");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", (e as Error).message);
  await page.screenshot({ path: "source-fail.png" });
} finally {
  await browser.close();
}
