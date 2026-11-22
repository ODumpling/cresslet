// Screenshots of every studio view, dark and light, desktop and phone (visual check for UI changes).
// Run with the server up (CRESSLET_ADMIN_TOKEN=e2e-admin CRESSLET_SITE_ADMINS=admin@example.com npm run dev): node shots.ts <outdir>
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const out = process.argv[2] ?? ".";
const call = async (path: string, token: string, body?: object) => (await fetch(base + path, {
  method: body ? "POST" : "GET",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: body && JSON.stringify(body),
})).json();
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin";
const { token } = await call("/v1/accounts", admin, { email: "admin@example.com" });
for (const name of ["todo-api", "landing"]) await call("/v1/deploys", token, { files: [{ path: "index.html", data: `<h1>${name}</h1>` }] });
const browser = await chromium.launch();
for (const scheme of ["dark", "light"] as const) {
  for (const [vp, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
    const page = await browser.newPage({ viewport: size, colorScheme: scheme });
    await page.addInitScript(([t]) => { localStorage.setItem("cresslet.token", t); localStorage.setItem("cresslet.email", "admin@example.com"); }, [token]);
    for (const [route, file] of [["/", "home"], ["/settings", "settings"], ["/admin", "admin"]]) {
      await page.goto(base + route);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/${file}-${scheme}-${vp}.png`, fullPage: vp === "desktop" });
    }
    await page.close();
  }
}
// The workspace: a project from the react template, once its preview runs.
for (const [scheme, size, vp] of [["dark", { width: 1440, height: 900 }, "desktop"], ["light", { width: 1440, height: 900 }, "desktop"], ["dark", { width: 390, height: 844 }, "phone"]] as const) {
  const page = await browser.newPage({ viewport: size, colorScheme: scheme });
  await page.goto(base + "/");
  await page.getByRole("button", { name: /react/ }).click();
  await page.frameLocator("#preview").getByRole("heading", { name: "Todos" }).waitFor({ timeout: 120000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/workspace-${scheme}-${vp}.png` });
  await page.close();
}
await browser.close();
