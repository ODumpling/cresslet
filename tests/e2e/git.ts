// Browser e2e for source control (studio/git.ts, server/git.ts): connect GitHub, create a repository from the
// workspace, edit in the Code view (a branch is started), Deploy (the branch is merged into main, main had a commit of
// its own so its files come in, main is built and deployed, the deploy records main @ the merge), then a conflict
// that stops the deploy before anything goes live. GitHub is tests/fake_github.ts; the server runs in this process.
// Needs the studio built (npm run build). Run: cd tests/e2e && node git.ts [outdir]
import { chromium } from "@playwright/test";
import { serve } from "@hono/node-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server/main.ts";
import { loadConfig } from "../../server/config.ts";
import { fakeGithub } from "../fake_github.ts";

const out = process.argv[2] ?? ".";
const PORT = Number(process.env.E2E_PORT ?? 8797);
const base = `http://localhost:${PORT}`;
const fail = (m: string): never => { throw new Error(m); };

const gh = await fakeGithub({ clientId: "cid", clientSecret: "csecret" });
const octo = gh.user("octo");
gh.authorizeAs(octo);
const dataDir = await mkdtemp(join(tmpdir(), "cresslet-e2e-git-"));
const defaults = loadConfig({ dataDir });
const srv = await createServer(loadConfig({
  dataDir, port: PORT, publicPort: PORT, domain: "localhost", adminToken: "adm",
  git: { ...defaults.git, githubApp: { appId: "1", clientId: "cid", clientSecret: "csecret", slug: "cresslet-e2e" }, webUrl: gh.base, apiUrl: gh.base },
}));
const http = serve({ fetch: srv.handler, port: PORT });
http.on("upgrade", srv.upgrade);
const call = async (path: string, token: string, body?: object) => (await fetch(base + path, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
})).json();
const { token } = await call("/v1/accounts", "adm", { email: "octo@example.com" });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript((t) => localStorage.setItem("cresslet.token", t), token);
page.on("dialog", (d) => d.accept());
const logs: string[] = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const toast = (text: string | RegExp, timeout = 120000) => page.locator("#toast", { hasText: text }).waitFor({ timeout });
const deployLog = () => page.locator("#deploy-log").textContent();

try {
  await page.goto(base + "/");
  await page.getByRole("button", { name: /react/ }).click();
  await page.waitForURL(/\/p\//);
  await page.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 180000 });
  console.log("preview rendered");

  // First deploy: the app's address (a repository links to an app).
  await page.locator("#deploy-btn").click();
  await page.locator("#deploy-confirm").click();
  await toast("Deployed:", 180000);
  const app = (await page.locator("#deploy-link .deploy-url").textContent())!.split(".")[0]!; // shown once deployed
  console.log("deployed", app);

  // Connect Git → Connect GitHub → (GitHub approves) → back in the project, the dialog opens again.
  await page.locator("#git-btn", { hasText: "Connect Git" }).click();
  await page.locator("#git-connect-github").click();
  await page.waitForURL(/#cresslet_git=connected|\/p\/[^#]+$/, { timeout: 30000 });
  await page.locator("#git-link").waitFor({ timeout: 180000 });
  await page.screenshot({ path: `${out}/git-connect.png` });
  if ((await page.locator("#git-repo-name").inputValue()) !== app) fail("repository name isn't the app's");
  await page.locator("#git-link").click();
  await page.locator("#git-btn-branch", { hasText: "main" }).waitFor({ timeout: 60000 });
  await page.locator("#git-dialog").evaluate((d: HTMLDialogElement) => d.close());
  const full = `octo/${app}`;
  const pushed = gh.files(full);
  if (!pushed["src/App.tsx"]) fail(`not pushed: ${Object.keys(pushed)}`);
  if (Object.keys(pushed).some((p) => /^\.env\.cresslet$|node_modules|^dist\//.test(p))) fail(`local files pushed: ${Object.keys(pushed)}`);
  console.log("linked and pushed:", Object.keys(pushed).length, "files");

  // Someone commits to main on GitHub meanwhile.
  gh.write(gh.repo(full), "main", { "NOTES.md": "from GitHub\n" }, "Add notes", "teammate");

  // A hand edit on main: it moves to a branch of its own.
  await page.locator("#view-code").click();
  await page.locator('#tree button[data-path="src/App.tsx"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n// edited in the studio\n");
  await page.locator("#git-btn-branch", { hasText: "edit/src-app" }).waitFor({ timeout: 30000 });
  await toast(/Editing on a new branch, edit\/src-app/);
  await page.screenshot({ path: `${out}/git-branch.png` });
  console.log("on branch edit/src-app");

  // Deploy = merge into main, then deploy main.
  const before = await call(`/v1/apps/${app}`, token);
  await page.locator("#deploy-btn").click();
  await toast("Deployed:", 180000);
  const log = (await deployLog())!;
  for (const want of ["merging edit/src-app into main", "main had commits of its own", `built from ${full} main @`]) {
    if (!log.includes(want)) fail(`deploy log lacks "${want}":\n${log}`);
  }
  const mainSha = gh.repo(full).refs.get("main")!;
  const after = await call(`/v1/apps/${app}`, token);
  const dep = after.deploys[0];
  if (dep.id === before.app.currentDeployId || !dep.current) fail("no new live deploy");
  if (dep.git?.branch !== "main" || dep.git?.sha !== mainSha || dep.git?.repo !== full) fail(`deploy provenance: ${JSON.stringify(dep.git)}`);
  if (gh.commit(mainSha).parents.length !== 2) fail("not a merge commit");
  if (!gh.files(full)["src/App.tsx"].includes("// edited in the studio")) fail("edit not on main");
  if (gh.repo(full).refs.has("edit/src-app")) fail("merged branch not deleted");
  await page.locator("#git-btn-branch", { hasText: /^main$/ }).waitFor();
  await page.locator('#tree button[data-path="NOTES.md"]').waitFor(); // main's own commit came in
  await page.screenshot({ path: `${out}/git-deployed.png` });
  console.log("merged and deployed main @", mainSha.slice(0, 7));

  // A conflict: the same file changed here and on GitHub. Nothing goes live.
  await page.locator('#tree button[data-path="src/App.tsx"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// again\n");
  await page.locator("#git-btn-branch", { hasText: "edit/src-app" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500); // the save
  gh.write(gh.repo(full), "main", { "src/App.tsx": "export default () => null;\n" }, "Rewrite", "teammate");
  await page.locator("#deploy-btn").click();
  await toast(/Not deployed: edit\/src-app doesn't merge cleanly into main/, 60000);
  if (!(await deployLog())!.includes("Nothing was deployed")) fail("conflict not in the deploy log");
  const still = await call(`/v1/apps/${app}`, token);
  if (still.app.currentDeployId !== dep.id) fail("the live deploy changed after a conflict");
  await page.screenshot({ path: `${out}/git-conflict.png` });
  console.log("conflict stopped the deploy");

  // The app's Overview: the repository and the deploy's branch @ commit.
  await page.goto(`${base}/apps/${app}`);
  await page.locator("#app-repo", { hasText: full }).waitFor({ timeout: 30000 });
  await page.locator(".git-ref", { hasText: `main @ ${mainSha.slice(0, 7)}` }).waitFor();
  await page.screenshot({ path: `${out}/git-overview.png`, fullPage: true });

  // Settings: connected as octo.
  await page.goto(`${base}/settings`);
  await page.locator("#set-git", { hasText: "Connected to GitHub as octo" }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${out}/git-settings.png` });
  console.log("ok");
} catch (e) {
  console.error(logs.slice(-40).join("\n"));
  await page.screenshot({ path: `${out}/git-failure.png` }).catch(() => {});
  throw e;
} finally {
  await browser.close();
  http.close();
  await srv.close();
  await gh.close();
  await rm(dataDir, { recursive: true, force: true });
}
