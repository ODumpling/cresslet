// Browser e2e for source control (studio/git.ts, server/git.ts, server/stack.ts): connect GitHub, create a repository
// from the workspace, two AI builder requests (two changes, stacked, shown above the chat), a hand edit, Deploy (the
// top change is merged into main, main had a commit of its own so its files come in, main is built and deployed, the
// deploy records main @ the merge, the stack is landed), then a conflict that stops the deploy before anything goes
// live. GitHub is tests/fake_github.ts; the server runs in this process.
// Needs the studio built (npm run build). Run: cd tests/e2e && node git.ts [outdir]
import { chromium } from "@playwright/test";
import { serve } from "@hono/node-server";
import { createHmac } from "node:crypto";
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
  git: { ...defaults.git, githubApp: { appId: "1", clientId: "cid", clientSecret: "csecret", slug: "cresslet-e2e" }, webUrl: gh.base, apiUrl: gh.base, webhookSecret: "whsec" },
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
await page.addInitScript((t) => (localStorage.setItem("cresslet.token", t), localStorage.setItem("cresslet.anthropicKey", "sk-ant-e2e")), token);

// Claude, scripted (api.anthropic.com is replaced): resolves the conflict when asked to.
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };
function sse(content: Block[], stopReason: string) {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let s = ev("message_start", { message: { id: "msg_e2e", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  content.forEach((b, index) => {
    if (b.type === "text") {
      s += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      s += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      s += ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      s += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    s += ev("content_block_stop", { index });
  });
  return s + ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }) + ev("message_stop", {});
}
const RESOLVED = "export function App() {\n  return <h1>Both</h1>;\n}\n";
const replies: [Block[], string][] = [
  [[{ type: "tool_use", id: "d1", name: "write_file", input: { path: "src/due.ts", content: "export const due = true;\n" } }], "tool_use"],
  [[{ type: "text", text: "Added due dates." }], "end_turn"],
  [[{ type: "tool_use", id: "d2", name: "write_file", input: { path: "src/dark.css", content: "body { background: #111; }\n" } }], "tool_use"],
  [[{ type: "text", text: "Added dark mode." }], "end_turn"],
  [[{ type: "tool_use", id: "r1", name: "write_file", input: { path: "src/App.tsx", content: RESOLVED } }], "tool_use"],
  [[{ type: "text", text: "Resolved the conflict." }], "end_turn"],
];
const claudeAsked: string[] = [];
const cors = { "access-control-allow-origin": base, "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
await page.route("https://api.anthropic.com/**", async (route) => {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  claudeAsked.push(JSON.stringify(req.postDataJSON()?.messages?.at(-1)?.content ?? ""));
  const r = replies.shift();
  if (!r) return route.fulfill({ status: 500, headers: cors, body: "{}" });
  return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse(...r) });
});
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
  const pushedSha = gh.repo(full).refs.get("main")!;
  if (!pushed["src/App.tsx"]) fail(`not pushed: ${Object.keys(pushed)}`);
  if (Object.keys(pushed).some((p) => /^\.env\.cresslet$|node_modules|^dist\//.test(p))) fail(`local files pushed: ${Object.keys(pushed)}`);
  console.log("linked and pushed:", Object.keys(pushed).length, "files");

  // Someone commits to main on GitHub meanwhile.
  gh.write(gh.repo(full), "main", { "NOTES.md": "from GitHub\n" }, "Add notes", "teammate");

  // Two AI builder requests: two changes, each on a branch of its own cut from the one below, shown as a stack.
  const input = page.getByLabel("Message to Claude");
  const STACK = "feat/add-due-dates-to-tasks";
  await input.fill("Add due dates to tasks");
  await input.press("Enter");
  await page.locator("#builder-log .notice", { hasText: "Committed as change 1 of the stack" }).waitFor({ timeout: 60000 });
  await page.locator("#git-btn-branch", { hasText: `${STACK}/1-add-due-dates-to-tasks` }).waitFor();
  await input.fill("Dark mode");
  await input.press("Enter");
  await page.locator("#builder-log .notice", { hasText: "Committed as change 2 of the stack" }).waitFor({ timeout: 60000 });
  const c1 = gh.repo(full).refs.get(`${STACK}/1-add-due-dates-to-tasks`), c2 = gh.repo(full).refs.get(`${STACK}/2-dark-mode`);
  if (!c1 || !c2) fail(`no change branches: ${[...gh.repo(full).refs.keys()]}`);
  if (gh.commit(c2!).parents[0] !== c1 || gh.commit(c1!).parents[0] !== pushedSha) fail("the changes aren't a straight chain on main");
  if (gh.files(full, `${STACK}/1-add-due-dates-to-tasks`)["src/dark.css"] || !gh.files(full, `${STACK}/2-dark-mode`)["src/due.ts"]) fail("a change holds the wrong turns");
  await page.locator("#stack-panel .stack-row[data-here]", { hasText: "2 · Dark mode" }).waitFor({ timeout: 30000 });
  await page.locator("#stack-panel .stack-row", { hasText: "1 · Add due dates to tasks" }).waitFor();
  await page.locator("#stack-panel").screenshot({ path: `${out}/git-stack.png` });
  await page.screenshot({ path: `${out}/git-stack-workspace.png` });
  console.log("two changes stacked:", `${STACK}/1…`, `${STACK}/2…`);

  // A hand edit after them: it goes into the top change (pushed with the deploy).
  await page.locator("#view-code").click();
  await page.locator('#tree button[data-path="src/App.tsx"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n// edited in the studio\n");
  await page.locator("#git-btn .git-dirty").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500); // the save

  // Deploy = merge the top change into main, then deploy main: the stack is landed.
  const before = await call(`/v1/apps/${app}`, token);
  await page.locator("#deploy-btn").click();
  await toast("Deployed:", 180000);
  const log = (await deployLog())!;
  for (const want of [`merging ${STACK}/2-dark-mode into main`, "main had commits of its own", `built from ${full} main @`]) {
    if (!log.includes(want)) fail(`deploy log lacks "${want}":\n${log}`);
  }
  if ([...gh.repo(full).refs.keys()].some((b) => b.startsWith(STACK + "/"))) fail(`landed stack's branches not deleted: ${[...gh.repo(full).refs.keys()]}`);
  if (!gh.files(full)["src/due.ts"] || !gh.files(full)["src/dark.css"]) fail("the stack's changes aren't on main");
  await page.locator("#stack-panel").waitFor({ state: "detached", timeout: 30000 });
  const mainSha = gh.repo(full).refs.get("main")!;
  const after = await call(`/v1/apps/${app}`, token);
  const dep = after.deploys[0];
  if (dep.id === before.app.currentDeployId || !dep.current) fail("no new live deploy");
  if (dep.git?.branch !== "main" || dep.git?.sha !== mainSha || dep.git?.repo !== full) fail(`deploy provenance: ${JSON.stringify(dep.git)}`);
  if (gh.commit(mainSha).parents.length !== 2) fail("not a merge commit");
  if (!gh.files(full)["src/App.tsx"].includes("// edited in the studio")) fail("edit not on main");
  await page.locator("#git-btn-branch", { hasText: /^main$/ }).waitFor();
  await page.locator('#tree button[data-path="NOTES.md"]').waitFor(); // main's own commit came in
  await page.screenshot({ path: `${out}/git-deployed.png` });
  console.log("merged and deployed main @", mainSha.slice(0, 7));

  // A conflict: the same file changed here (by hand, on main) and on GitHub. Deploy makes the edit a change of its
  // own, which doesn't merge. Nothing goes live.
  const EDITS = "feat/edits-made-in-the-studio/1-edits-made-in-the-studio";
  await page.locator('#tree button[data-path="src/App.tsx"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// again\n");
  await page.locator("#git-btn .git-dirty").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500); // the save
  gh.write(gh.repo(full), "main", { "src/App.tsx": "export default () => null;\n" }, "Rewrite", "teammate");
  await page.locator("#deploy-btn").click();
  await toast(/Not deployed: feat\/edits-made-in-the-studio\/1-edits-made-in-the-studio doesn't merge cleanly into main/, 60000);
  await page.locator("#git-btn-branch", { hasText: EDITS }).waitFor();
  if (!(await deployLog())!.includes("Nothing was deployed")) fail("conflict not in the deploy log");
  const still = await call(`/v1/apps/${app}`, token);
  if (still.app.currentDeployId !== dep.id) fail("the live deploy changed after a conflict");
  await page.screenshot({ path: `${out}/git-conflict.png` });
  console.log("conflict stopped the deploy");

  // Resolved with the AI builder: main's merge loaded with markers, Claude rewrites the file, the turn commits the
  // merge (main as a parent), and Deploy fast-forwards main to it.
  await page.locator("#toast").getByRole("button", { name: "Resolve with the AI builder" }).click();
  await page.waitForFunction(() => (document.getElementById("builder-input") as HTMLTextAreaElement | null)?.value.includes("<<<<<<<"), null, { timeout: 30000 });
  if (!(await page.locator(".cm-content").innerText()).includes(`<<<<<<< ${EDITS}`)) fail("markers not in the editor");
  await input.press("Enter");
  await page.locator(".msg.assistant", { hasText: "Resolved the conflict." }).waitFor({ timeout: 60000 });
  await page.locator("#builder-log .notice", { hasText: `Committed to ${EDITS}` }).waitFor({ timeout: 30000 });
  if (!claudeAsked[0]?.includes("Source control: this project is linked")) fail("no source control note to Claude");
  const resolvedHead = gh.repo(full).refs.get(EDITS)!;
  if (gh.commit(resolvedHead).parents[1] !== gh.repo(full).refs.get("main")) fail("not committed as a merge of main");
  await page.locator("#deploy-btn").click();
  await toast("Deployed:", 180000);
  if (gh.repo(full).refs.get("main") !== resolvedHead) fail("main didn't fast-forward to the resolution");
  if (gh.files(full)["src/App.tsx"] !== RESOLVED) fail("resolution not on main");
  await page.screenshot({ path: `${out}/git-resolved.png` });
  console.log("conflict resolved by the AI builder and deployed");

  // A protected main takes a pull request.
  gh.repo(full).protected.add("main");
  await page.locator("#view-code").click();
  await page.locator('#tree button[data-path="src/App.tsx"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// needs review\n");
  await page.locator("#git-btn .git-dirty").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator("#deploy-btn").click();
  await toast(/Not deployed: main is protected/, 60000);
  await page.locator("#toast").getByRole("button", { name: "Open a pull request" }).click();
  await toast(/Pull request #1/, 30000);
  if (gh.repo(full).pulls.length !== 1 || gh.repo(full).pulls[0].head !== EDITS) fail(`no pull request from ${EDITS}`);
  await page.screenshot({ path: `${out}/git-pull-request.png` });
  console.log("protected main: pull request opened");

  // A webhook says main moved on GitHub: the branch pill shows it.
  const upstreamSha = gh.write(gh.repo(full), "main", { "CHANGELOG.md": "x\n" }, "Changelog", "teammate");
  const payload = JSON.stringify({ ref: "refs/heads/main", after: upstreamSha, repository: { id: gh.repo(full).id } });
  const hook = await fetch(`${base}/v1/webhooks/github`, {
    method: "POST", body: payload,
    headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=" + createHmac("sha256", "whsec").update(payload).digest("hex") },
  });
  if (!hook.ok) fail(`webhook ${hook.status}`);
  await page.reload();
  await page.locator("#git-btn .git-upstream", { hasText: "main" }).waitFor({ timeout: 180000 });
  await page.screenshot({ path: `${out}/git-upstream.png` });
  console.log("webhook: upstream main shown");

  // A project never deployed: its address reserved (nothing live), then a repository linked.
  await page.goto(base + "/");
  await page.getByRole("button", { name: /vanilla/ }).click();
  await page.waitForURL(/\/p\//);
  await page.locator("#git-btn", { hasText: "Connect Git" }).click({ timeout: 180000 });
  await page.locator("#git-reserve").click();
  await page.locator("#deploy-dialog-title", { hasText: "Choose the app's address" }).waitFor();
  await page.locator("#deploy-confirm").click();
  await page.locator("#git-link").waitFor({ timeout: 30000 });
  const reserved = await page.locator("#git-repo-name").inputValue();
  const fresh = await call(`/v1/apps/${reserved}`, token);
  if (fresh.app.currentDeployId !== null || fresh.deploys.length) fail("reserving deployed something");
  await page.locator("#git-link").click();
  await page.locator("#git-btn-branch", { hasText: "main" }).waitFor({ timeout: 60000 });
  if (!gh.files(`octo/${reserved}`)["index.html"]) fail("reserved app's repository wasn't pushed");
  await page.screenshot({ path: `${out}/git-reserved.png` });
  console.log("reserved", reserved, "and linked before any deploy");

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
