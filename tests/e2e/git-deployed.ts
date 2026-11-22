// Browser e2e for linking an app that's already deployed (no workspace): deployed from the CLI with its source, then
// the app's Settings tab → Connect GitHub → (GitHub approves) → back on the tab → Create and push: the live deploy's
// source lands in a new repository, secrets stripped. GitHub is tests/fake_github.ts; the server runs in this process.
// Needs the studio built (npm run build). Run: cd tests/e2e && node git-deployed.ts [outdir]
import { chromium } from "@playwright/test";
import { serve } from "@hono/node-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server/main.ts";
import { loadConfig } from "../../server/config.ts";
import { fakeGithub } from "../fake_github.ts";

const out = process.argv[2] ?? ".";
const PORT = Number(process.env.E2E_PORT ?? 8798);
const base = `http://localhost:${PORT}`;
const fail = (m: string): never => { throw new Error(m); };

const gh = await fakeGithub({ clientId: "cid", clientSecret: "csecret" });
gh.authorizeAs(gh.user("octo"));
const dataDir = await mkdtemp(join(tmpdir(), "cresslet-e2e-git-deployed-"));
const defaults = loadConfig({ dataDir });
const srv = await createServer(loadConfig({
  dataDir, port: PORT, publicPort: PORT, domain: "localhost", adminToken: "adm",
  git: { ...defaults.git, githubApp: { appId: "1", clientId: "cid", clientSecret: "csecret", slug: "cresslet-e2e" }, webUrl: gh.base, apiUrl: gh.base },
}));
const http = serve({ fetch: srv.handler, port: PORT });
const call = async (path: string, token: string, body?: object) => (await fetch(base + path, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
})).json();
const { token } = await call("/v1/accounts", "adm", { email: "octo@example.com" });
// What `cresslet deploy` sends: the built files and the project's source.
const dep = await call("/v1/deploys", token, {
  app: "shop", source: "cli",
  files: [{ path: "index.html", data: "<h1>Shop</h1>" }],
  sources: [
    { path: "index.html", data: "<h1>Shop</h1>" },
    { path: "package.json", data: "{\"name\":\"shop\"}\n" },
    { path: ".env", data: "VITE_TITLE=Shop\nSTRIPE_KEY=sk_live_123\n" },
    { path: ".env.local", data: "DB=secret\n" },
  ],
});
if (!dep.deploy) fail(`deploy: ${JSON.stringify(dep)}`);
// One deployed without its source (an older CLI): there's nothing to push, so only a repository the user has.
await call("/v1/deploys", token, { app: "bare", source: "cli", files: [{ path: "index.html", data: "bare" }] });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);
const logs: string[] = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const toast = (text: string | RegExp, timeout = 30000) => page.locator("#toast", { hasText: text }).waitFor({ timeout });

try {
  await page.goto(`${base}/apps/shop/settings`);
  await page.locator("#repo-title").waitFor();
  await page.screenshot({ path: `${out}/git-deployed-connect.png`, fullPage: true });
  await page.locator("#repo-connect-github").click();
  await page.waitForURL(/\/apps\/shop\/settings/, { timeout: 30000 });
  await toast("GitHub connected");
  await page.locator("#repo-link").waitFor();
  if ((await page.locator("#repo-name").inputValue()) !== "shop") fail("repository name isn't the app's");
  if (new URL(page.url()).hash) fail(`hash left behind: ${page.url()}`);
  await page.screenshot({ path: `${out}/git-deployed-form.png`, fullPage: true });
  await page.locator("#repo-link").click();
  await toast("Linked to octo/shop");
  await page.locator("#repo-linked", { hasText: "octo/shop" }).waitFor();
  if (await page.locator("#repo-title").count() !== 1) fail("the Repository section is shown twice");
  await page.screenshot({ path: `${out}/git-deployed-linked.png`, fullPage: true });

  const pushed = gh.files("octo/shop");
  const paths = Object.keys(pushed).sort().join(",");
  if (paths !== ".env,index.html,package.json") fail(`pushed: ${paths}`);
  if (pushed[".env"] !== "VITE_TITLE=Shop\n") fail(`.env pushed as ${JSON.stringify(pushed[".env"])}`);
  const app = await call("/v1/apps/shop", token);
  if (app.repo?.fullName !== "octo/shop" || app.repo.lastSyncedSha !== gh.repo("octo/shop").refs.get("main")) fail(`app repo: ${JSON.stringify(app.repo)}`);

  // The Overview shows it.
  await page.getByRole("link", { name: "Overview" }).click();
  await page.locator("#app-repo", { hasText: "octo/shop" }).waitFor();
  // Deployed without its source: Create is off (no empty repository made for nothing), and it says why.
  await page.goto(`${base}/apps/bare/settings`);
  await page.locator("#repo-form", { hasText: "no source uploaded with it" }).waitFor();
  if (!await page.getByRole("radio", { name: "Create a new repository" }).isDisabled()) fail("Create offered without source");
  if (!await page.locator("#repo-link").isDisabled()) fail("Link enabled without a choice");
  await page.screenshot({ path: `${out}/git-deployed-nosource.png`, fullPage: true });
  console.log("linked an already-deployed app from its Settings tab:", paths);
} catch (e) {
  await page.screenshot({ path: `${out}/git-deployed-fail.png`, fullPage: true }).catch(() => {});
  console.error(logs.slice(-30).join("\n"));
  throw e;
} finally {
  await browser.close();
  http.close();
  await srv.close();
  await gh.close();
  await rm(dataDir, { recursive: true, force: true });
}
