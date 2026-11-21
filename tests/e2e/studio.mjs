// Browser e2e: template → in-browser npm install → preview → API → Deploy (pick the address) → live app; Settings → API tokens.
// SHOTS=<dir> also saves screenshots of the address picker.
// Run: start the server (CRESSLET_ADMIN_TOKEN=e2e-admin npm run dev), then:
//   cd tests/e2e && npm i && npx playwright install chromium && CRESSLET_ADMIN_TOKEN=e2e-admin node studio.mjs
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
  // A studio-origin blob: URL can't be loaded into the preview frame with the studio's origin (Chromium
  // partitions blob URLs by storage key). App workers run on the preview origin, so they can't mint one anyway.
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
  // First deploy: a generated address, editable; a taken one is refused before anything is built.
  const taken = `taken-${Date.now().toString(36)}`, mine = `mine-${Date.now().toString(36)}`;
  const owner = await (await fetch(base + "/v1/accounts", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin"}`, "content-type": "application/json" },
    body: JSON.stringify({ email: `taken-${Date.now()}@example.com` }),
  })).json();
  const made = await fetch(base + "/v1/deploys", {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
    body: JSON.stringify({ app: taken, files: [{ path: "index.html", data: "x" }] }),
  });
  if (made.status !== 201) throw new Error(`couldn't create ${taken}: ${made.status} ${await made.text()}`);
  await page.locator("#deploy-btn").click();
  const nameInput = page.getByRole("textbox", { name: "Address" });
  await page.locator("#deploy-name-status", { hasText: "is available" }).waitFor();
  const suggested = await nameInput.inputValue();
  if (!/^[a-z]+-[a-z]+-[0-9a-f]{4}$/.test(suggested)) throw new Error(`suggested name ${suggested}`);
  if (await page.evaluate(() => document.activeElement?.id) !== "deploy-name") throw new Error("the dialog didn't focus the address");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/deploy-suggested.png` });
  await nameInput.fill(taken);
  await page.locator("#deploy-name-status", { hasText: `${taken} is taken` }).waitFor();
  await page.locator("#deploy-confirm").click();
  if (!(await page.locator("#deploy-dialog").evaluate((d) => d.open))) throw new Error("deployed to a taken name");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/deploy-taken.png` });
  await nameInput.fill("Bad--Name");
  await page.locator("#deploy-name-status", { hasText: "single dashes" }).waitFor();
  if (await nameInput.inputValue() !== "bad--name") throw new Error("the address wasn't lowercased");
  await nameInput.fill(mine);
  await page.locator("#deploy-name-status", { hasText: `${mine} is available` }).waitFor();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/deploy-custom.png` });
  await page.locator("#deploy-confirm").click();
  await page.locator("#deploy-link").waitFor({ state: "visible", timeout: 60000 });
  const url = await page.locator("#deploy-link").getAttribute("href");
  if (!url.includes(`//${mine}.`)) throw new Error(`deployed to ${url}, not ${mine}`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/deploy-done.png` });
  console.log("deployed", url);
  console.log(await page.locator("#deploy-log").textContent());
  const p2 = await browser.newPage();
  await p2.goto(url);
  await p2.getByRole("heading", { name: "Todos" }).waitFor({ timeout: 15000 });
  await p2.getByPlaceholder("Add a todo").fill("on cresslet");
  await p2.getByRole("button", { name: "Add" }).click();
  await p2.getByText("on cresslet").waitFor({ timeout: 15000 });
  console.log("deployed app works");
  // App server code and `node` run on the preview origin too; the server survives its own background errors. neither can open the studio's IndexedDB (every
  // local project's files, including .env.cresslet). Probe from a node script, then from the app's server route.
  const term = page.locator(".xterm-rows");
  const waitTerm = async (re, what) => {
    for (let i = 0; !re.test(await term.innerText()); i++) {
      if (i > 150) throw new Error(`terminal never showed ${what}:\n${await term.innerText()}`);
      await page.waitForTimeout(200);
    }
    return re.exec(await term.innerText());
  };
  await page.getByRole("tab", { name: "Terminal" }).click();
  await page.locator(".xterm").click();
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(500);
  await page.keyboard.type(`node -e "indexedDB.databases().then((d) => console.log('studio-db=' + d.some((x) => x.name === 'cresslet-studio') + ' at=' + origin)); setTimeout(() => {}, 1000)"\n`);
  const [, nodeSees, nodeAt] = await waitTerm(/studio-db=(\w+) at=(\S+)/, "the node probe");
  if (nodeAt !== previewOrigin) throw new Error(`node ran on ${nodeAt}, not ${previewOrigin}`);
  if (nodeSees !== "false") throw new Error("a node script could see the studio's IndexedDB");
  console.log("node runs on", nodeAt);
  await page.waitForTimeout(1500); // its keep-alive timer, then the prompt is back
  await page.keyboard.type(`node -e "require('fs').writeFileSync('server/index.ts', 'setTimeout(() => { throw 42 }, 0); export default { fetch: async () => Response.json({ origin: self.origin, dbs: (await indexedDB.databases()).map((d) => d.name) }) }')" && npm run dev\n`);
  await waitTerm(/server ready[\s\S]*dev server on port/, "the restarted dev server");
  await waitTerm(/\[server\] 42/, "the server's own background error, logged");
  const probe = async () => {
    const f = await (await page.locator("#preview").elementHandle()).contentFrame();
    return f.evaluate(() => fetch("/api/probe").then((r) => r.json())).catch(() => null);
  };
  let served = null;
  for (let i = 0; !served?.origin && i < 50; i++) (served = await probe()) || (await page.waitForTimeout(300));
  if (served?.origin !== previewOrigin) throw new Error(`server code ran on ${served?.origin}, not ${previewOrigin}`);
  if (served.dbs.includes("cresslet-studio")) throw new Error("server code could see the studio's IndexedDB");
  console.log("server code runs on", served.origin, "and sees databases", JSON.stringify(served.dbs));
  // A relay reload takes its workers with it: API requests then fail fast (503), they don't hang.
  await page.evaluate(() => {
    const relay = document.querySelector('iframe[title="cresslet preview relay"]');
    relay.src = relay.src;
  });
  const stopped = async () => {
    const f = await (await page.locator("#preview").elementHandle()).contentFrame();
    return f.evaluate(() => fetch("/api/probe", { signal: AbortSignal.timeout(5000) }).then(async (r) => `${r.status} ${await r.text()}`).catch((e) => e.name)).catch(() => "");
  };
  let afterReload = "";
  for (let i = 0; !afterReload.startsWith("503") && i < 10; i++) (afterReload = await stopped()) || (await page.waitForTimeout(300));
  if (!/^503 server stopped: preview relay restarted/.test(afterReload)) throw new Error(`after a relay reload: ${afterReload}`);
  console.log("relay reload: server requests get", afterReload.slice(0, 40));
  await page.screenshot({ path: (process.argv[2] ?? ".") + "/studio.png" });
  await settings();
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", e.message);
  await page.screenshot({ path: (process.argv[2] ?? ".") + "/studio-fail.png" });
  console.log(await page.locator(".xterm-rows").innerText().catch(() => ""));
} finally {
  console.log(logs.slice(-30).join("\n"));
  await browser.close();
}

// Settings: create a scoped token, it works only within its scope, revoke it, it stops working.
async function settings() {
  const admin = process.env.CRESSLET_ADMIN_TOKEN;
  if (!admin) throw new Error("set CRESSLET_ADMIN_TOKEN (same as the server's) for the Settings check");
  const call = async (path, token, body) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const email = `e2e-${Date.now()}@example.com`;
  const root = (await call("/v1/accounts", admin, { email })).body.token;
  const files = [{ path: "index.html", data: "tokens e2e" }];
  const appName = (await call("/v1/deploys", root, { files })).body.app.name;

  const s = await browser.newPage();
  s.on("dialog", (d) => d.accept());
  await s.goto(base + "/");
  await s.evaluate(([t, e]) => (localStorage.setItem("cresslet.token", t), localStorage.setItem("cresslet.email", e)), [root, email]);
  await s.goto(base + "/#/settings");
  const tokens = s.locator("#tokens");
  await tokens.getByText("Operator-issued").waitFor({ timeout: 10000 });
  await tokens.getByText("this browser").waitFor();

  await s.getByLabel("Name", { exact: true }).fill("e2e ci");
  await s.getByLabel("Access", { exact: true }).selectOption("deploy");
  await s.getByLabel("Only these apps").check();
  await s.locator("#token-apps").getByLabel(appName).check();
  await s.getByRole("button", { name: "Create token" }).click();
  await s.locator("#token-new").waitFor({ state: "visible" });
  const secret = await s.locator("#token-new-value").inputValue();
  if (!secret.startsWith("clv_scoped_")) throw new Error(`no token shown after create: ${secret}`);
  const row = tokens.locator(".list-row", { hasText: "e2e ci" });
  await row.getByText(`deploy · ${appName}`).waitFor();
  await s.screenshot({ path: (process.argv[2] ?? ".") + "/settings.png", fullPage: true });

  const st = async (path, body) => (await call(path, secret, body)).status;
  if (await st("/v1/deploys", { app: appName, files }) !== 201) throw new Error("scoped token can't deploy its app");
  if (await st("/v1/deploys", { files }) !== 403) throw new Error("app-scoped token created a new app");
  if (await st("/v1/me/tokens") !== 403) throw new Error("deploy token can list tokens");
  await s.reload();
  await row.waitFor();
  if ((await s.locator("body").innerText()).includes(secret) || await s.locator("#token-new").isVisible() ||
    await s.locator("#token-new-value").inputValue()) throw new Error("secret shown again after reload");
  await row.getByText(/last used (?!never)/).waitFor();

  await row.getByRole("button", { name: "Revoke e2e ci" }).click();
  await row.waitFor({ state: "detached" });
  if (await st("/v1/me") !== 401) throw new Error("revoked token still works");
  if ((await call("/v1/me", root)).status !== 200) throw new Error("revoking one token broke another");
  console.log("settings: scoped token created, enforced, revoked");
  await s.close();
}
