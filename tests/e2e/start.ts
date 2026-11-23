// Browser e2e: the TanStack Start template in the studio (studio/start-build.ts): New project → in-browser npm install →
// SSR preview → sign up (server functions, db, kv session cookie) → todos → a new file route → an edit reloads the
// preview → Deploy → the same flow on the deployed app.
// Run: start the server (CRESSLET_ADMIN_TOKEN=e2e-admin npm run dev), then:
//   cd tests/e2e && npm i && npx playwright install chromium && node start.ts [screenshot dir]
import { chromium, type FrameLocator, type Page } from "@playwright/test";
import { studioMode } from "./studio-mode.ts";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const shots = process.argv[2] ?? ".";
// Every app belongs to an account: log the studio in as a fresh one (operator-issued; CRESSLET_ADMIN_TOKEN on the server).
const acct = await (await fetch(base + "/v1/accounts", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin"}`, "content-type": "application/json" },
  body: JSON.stringify({ email: `e2e-${Date.now()}@example.com` }),
})).json();
const browser = await chromium.launch();
studioMode(browser);
const page = await browser.newPage();
await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), acct.token);
const logs: string[] = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("response", async (r) => {
  if (r.status() >= 400) logs.push(`[${r.status()}] ${r.request().method()} ${r.url()} ${JSON.stringify(await r.request().allHeaders())} → ${(await r.text().catch(() => "")).slice(0, 300)}`);
});
const term = page.locator(".xterm-rows");
const waitTerm = async (re: RegExp, what: string, tries = 600) => {
  for (let i = 0; !re.test(await term.innerText()); i++) {
    if (i > tries) throw new Error(`terminal never showed ${what}:\n${await term.innerText()}`);
    await page.waitForTimeout(200);
  }
};
const frame = page.frameLocator("#preview");
// (the preview iframe: once it's shown it has a frame)
const previewFrame = async () => (await (await page.locator("#preview").elementHandle())!.contentFrame())!;
const user = { name: "Ada", email: `ada-${Date.now()}@example.com`, password: "correct horse battery" };

/** Sign up, add a todo, reload: the session (kv cookie) and the todo (db) are still there. */
async function signUpAndTodo(f: Page | FrameLocator, reload: () => Promise<unknown>, what: string) {
  await f.getByRole("link", { name: "Create an account" }).first().click();
  await f.getByRole("heading", { name: "Create an account" }).waitFor({ timeout: 30000 });
  await f.getByLabel("Name").fill(user.name);
  await f.getByLabel("Email").fill(user.email);
  await f.getByLabel("Password").fill(user.password);
  await f.getByRole("button", { name: /Sign up|Create/ }).click();
  await f.getByRole("heading", { name: `Hi, ${user.name}` }).waitFor({ timeout: 30000 });
  await f.getByRole("textbox", { name: "New todo" }).fill(`todo from ${what}`);
  await f.getByRole("button", { name: "Add" }).click();
  await f.getByText(`todo from ${what}`).waitFor({ timeout: 15000 });
  await reload();
  await f.getByText(`todo from ${what}`).waitFor({ timeout: 30000 });
  console.log(`${what}: signed up, todo kept across a reload`);
}

try {
  await page.goto(base + "/");
  await page.getByRole("button", { name: /tanstack-start/ }).click();
  await page.waitForURL(/\/p\//);
  await frame.getByRole("heading", { name: "TanStack Start on Cresslet" }).waitFor({ timeout: 240000 });
  console.log("preview rendered");

  // Server-rendered: the page's HTML has the content before any script runs; assets come from the client build.
  const f = await previewFrame();
  const html = await f.evaluate(() => fetch("/").then((r) => r.text()));
  if (!html.includes("TanStack Start on Cresslet")) throw new Error(`not server-rendered:\n${html.slice(0, 500)}`);
  const css = /href="(\/assets\/styles-[^"]+\.css)"/.exec(html)?.[1];
  const js = /src="(\/assets\/client-[^"]+\.js)"/.exec(html)?.[1];
  if (!css || !js) throw new Error(`no client assets in the page:\n${html.slice(0, 800)}`);
  for (const [u, type] of [[css, "text/css"], [js, "text/javascript"]]) {
    const r = await f.evaluate((u) => fetch(u).then((r) => [r.status, r.headers.get("content-type")] as const), u);
    if (r[0] !== 200 || !r[1]!.startsWith(type)) throw new Error(`${u}: ${r}`);
  }
  const health = await f.evaluate(() => fetch("/api/health").then((r) => r.json()));
  if (!health.ok || !health.sqlite) throw new Error(`/api/health: ${JSON.stringify(health)}`);
  // hydrated: client navigation works without a full load
  await f.evaluate(() => (window.__marker = 1));
  await frame.getByRole("link", { name: "Sign in" }).first().click();
  await frame.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 15000 });
  if ((await (await previewFrame()).evaluate(() => window.__marker)) !== 1) throw new Error("navigation reloaded the page: not hydrated");
  await frame.getByRole("link", { name: "Cresslet app" }).click();
  console.log("SSR + hydration + /api/health");
  await page.screenshot({ path: `${shots}/start-preview.png` });

  // a real reload of the frame's page (the same route), seen through a marker the old document had
  const reloadFrame = async () => {
    await (await previewFrame()).evaluate(() => ((window.__old = 1), setTimeout(() => location.reload())));
    for (let i = 0; i < 100; i++) {
      if ((await (await previewFrame()).evaluate(() => window.__old).catch(() => 1)) === undefined) return;
      await page.waitForTimeout(200);
    }
    throw new Error("the preview didn't reload");
  };
  await signUpAndTodo(frame, reloadFrame, "preview");
  // The page's own POSTs pass the template's CSRF check (it runs before a server function is looked up) whatever their
  // body type; a navigation's (a form another page submits into the preview) doesn't.
  const csrf = (init: { body: string; headers?: Record<string, string> }) => previewFrame().then((f) => f.evaluate((i) => fetch("/_serverFn/nope", { method: "POST", ...i, body: i.body === "form" ? new FormData() : i.body }).then((r) => r.status), init));
  for (const body of ["x", "form"]) {
    const st = await csrf({ body });
    if (st === 403) throw new Error(`a same-origin POST (${body}) was refused as cross-site`);
  }
  if ((await csrf({ body: "x", headers: { accept: "text/html,application/xhtml+xml" } })) !== 403) throw new Error("a navigation-like POST passed CSRF");
  console.log("CSRF: the page's fetches pass, navigations don't");
  await page.screenshot({ path: `${shots}/start-dashboard.png` });

  // A new file route (dev restarted: the route tree is regenerated), then an edit in the editor: a save rebuilds and
  // reloads the preview.
  if (!(await page.locator(".xterm").isVisible())) await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.locator(".xterm").click();
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(500);
  await page.keyboard.type(`node -e "require('fs').writeFileSync('src/routes/about.tsx', 'import { createFileRoute } from \\"@tanstack/react-router\\";\\nexport const Route = createFileRoute(\\"/about\\")({ component: () => <main><h1>About this app</h1></main> });\\n')" && grep -c about src/routeTree.gen.ts; cresslet dev\n`);
  await waitTerm(/\n0\s*\n[\s\S]*server ready/, "dev restarted with the new route");
  await page.locator("#preview-path").fill("/about");
  await page.locator("#preview-path").press("Enter");
  await frame.getByRole("heading", { name: "About this app" }).waitFor({ timeout: 30000 });
  // reach it again in the app (the address box says /): a rebuild must reload the page the preview is on
  await page.locator("#preview-path").fill("/");
  await page.locator("#preview-path").press("Enter");
  await frame.getByRole("heading", { name: "TanStack Start on Cresslet" }).waitFor({ timeout: 30000 });
  await (await previewFrame()).evaluate(() => window.__TSR_ROUTER__.navigate({ to: "/about" }));
  await frame.getByRole("heading", { name: "About this app" }).waitFor({ timeout: 30000 });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Code/ }).first().click().catch(() => {});
  await page.locator('#tree button[data-path="src/routes/about.tsx"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(`import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/about")({ component: () => <main><h1>About, edited</h1></main> });\n`);
  await page.getByRole("button", { name: /Preview/ }).first().click().catch(() => {});
  await frame.getByRole("heading", { name: "About, edited" }).waitFor({ timeout: 30000 });
  console.log("new route + edit: rebuilt and reloaded");

  // Deploy from the studio, then the same flow on the deployed app.
  await page.locator("#deploy-btn").click();
  await page.locator("#deploy-name-status", { hasText: "is available" }).waitFor({ timeout: 15000 });
  await page.locator("#deploy-confirm").click();
  await page.locator("#deploy-link").waitFor({ state: "visible", timeout: 180000 });
  const url = (await page.locator("#deploy-link").getAttribute("href"))!; // visible: it has one
  console.log("deployed", url);
  console.log(await page.locator("#deploy-log").textContent());
  const p2 = await browser.newPage();
  p2.on("pageerror", (e) => logs.push(`[deployed pageerror] ${e.message}`));
  await p2.goto(url);
  await p2.getByRole("heading", { name: "TanStack Start on Cresslet" }).waitFor({ timeout: 30000 });
  const dh = await p2.evaluate(() => fetch("/api/health").then((r) => r.json()));
  if (!dh.ok) throw new Error(`deployed /api/health: ${JSON.stringify(dh)}`);
  await signUpAndTodo(p2, () => p2.reload(), "deployed");
  await p2.goto(new URL("/about", url).href);
  await p2.getByRole("heading", { name: "About, edited" }).waitFor({ timeout: 15000 });
  await p2.screenshot({ path: `${shots}/start-deployed.png` });
  console.log("deployed app works");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", (e as Error).message);
  await page.screenshot({ path: `${shots}/start-fail.png` });
  console.log(await term.innerText().catch(() => ""));
} finally {
  console.log(logs.slice(-40).join("\n"));
  await browser.close();
}
