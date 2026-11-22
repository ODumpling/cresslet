// Browser e2e: on a server with GitHub login, projects need a session. Logged out: the landing page only, no project
// list or recent projects, /p/<id> goes back to the landing page, and a template asks for the login.
// Mocks GET /v1 so the dev server looks like it has GitHub login set up.
// Run: start the server (CRESSLET_ADMIN_TOKEN=e2e-admin npm run dev), then: cd tests/e2e && CRESSLET_ADMIN_TOKEN=e2e-admin node login-gate.ts
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const acct = await (await fetch(`${base}/v1/accounts`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin"}`, "content-type": "application/json" },
  body: JSON.stringify({ email: `gate-${Date.now()}@example.com` }),
})).json();
const meta = { ...await (await fetch(`${base}/v1`)).json(), auth: { github: true, cli: true } };

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route((u) => u.pathname === "/v1", (r) => r.fulfill({ json: meta }));
await ctx.route((u) => u.pathname === "/v1/auth/github", (r) => r.fulfill({ contentType: "text/html", body: "<h1>github login</h1>" }));
const page = await ctx.newPage();
const fail = (m: string) => { throw new Error(m); };
try {
  // A project already in this browser's storage.
  await page.goto(base + "/");
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("cresslet-studio", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("projects", { keyPath: "id" });
    req.onsuccess = () => {
      const t = req.result.transaction("projects", "readwrite");
      t.objectStore("projects").put({ id: "gate1", name: "Secret project", template: "react", files: {}, deploy: null, updatedAt: Date.now() });
      t.oncomplete = () => (req.result.close(), resolve());
      t.onerror = () => reject(t.error);
    };
  }));

  // Logged out: the landing page, not the projects.
  await page.reload();
  await page.locator("#landing").waitFor();
  if (await page.locator("#home").isVisible()) fail("projects page shown logged out");
  if (await page.locator("#recent-wrap").isVisible()) fail("recent projects shown logged out");
  if (await page.getByText("Secret project").count()) fail("a project's name shown logged out");
  if (!/Log in with GitHub to start building/.test((await page.locator("#landing-note").textContent())!)) fail("landing still says no account needed");
  console.log("logged out: landing only");

  // Opening a project goes back to the landing page, and comes back to it after the login.
  await page.goto(base + "/p/gate1");
  await page.waitForURL((u) => u.pathname === "/");
  await page.locator("#landing").waitFor();
  if (await page.locator("#workspace").isVisible()) fail("workspace opened logged out");
  if (await page.evaluate(() => sessionStorage.getItem("cresslet.afterLogin")) !== "/p/gate1") fail("project not remembered for after the login");
  console.log("logged out: /p/<id> → landing");

  // A template asks for the login instead of making a project.
  await page.locator("#landing-templates").getByRole("button", { name: /react/ }).click();
  await page.waitForURL(/\/v1\/auth\/github/);
  console.log("logged out: template → GitHub login");

  // Logged in: the projects page lists it.
  const inPage = await ctx.newPage();
  await inPage.addInitScript((t) => localStorage.setItem("cresslet.token", t), acct.token);
  await inPage.goto(base + "/");
  await inPage.locator("#home").waitFor();
  await inPage.locator("#projects").getByText("Secret project").waitFor();
  await inPage.locator("#recent").getByText("Secret project").waitFor();
  console.log("logged in: projects listed");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", (e as Error).message);
  await page.screenshot({ path: "login-gate-fail.png" });
} finally {
  await browser.close();
}
