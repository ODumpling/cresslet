// Browser e2e: email + password login. The landing page's Log in goes to /login; a wrong password says so there, the
// right one logs in; Settings → Account sets and changes the password; the CLI login page comes back after the login.
// Run: start the server (CRESSLET_PASSWORD_LOGIN=true CRESSLET_ADMIN_TOKEN=e2e-admin npm run dev), then:
// cd tests/e2e && CRESSLET_ADMIN_TOKEN=e2e-admin node password-login.ts [outdir for screenshots]
import { chromium, type Page } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const out = process.argv[2];
const admin = process.env.CRESSLET_ADMIN_TOKEN ?? "e2e-admin";
const fail = (m: string) => { throw new Error(m); };
const create = async (body: unknown) => (await fetch(`${base}/v1/accounts`, {
  method: "POST",
  headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})).json();

if (!(await (await fetch(`${base}/v1`)).json()).auth?.password) fail("password login is off: start the server with CRESSLET_PASSWORD_LOGIN=true");
const n = Date.now();
const withPw = `pw-${n}@example.com`, without = `nopw-${n}@example.com`;
await create({ email: withPw, password: "first-pass-1" });
await create({ email: without });

const browser = await chromium.launch();
const page = await browser.newPage();
const shot = async (p: Page, name: string) => out && await p.screenshot({ path: `${out}/${name}.png` });
const logIn = async (email: string, password: string) => {
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.locator("#login-submit").click();
};
try {
  // Landing → /login.
  await page.goto(base + "/");
  await page.locator("#landing").waitFor();
  if (!/Log in to start building/.test((await page.locator("#landing-note").textContent())!)) fail("landing doesn't offer the login");
  await page.locator("#landing-login").click();
  await page.waitForURL((u) => u.pathname === "/login");
  if (await page.locator("#account-label").textContent() !== "Log in") fail("the sidebar still offers only GitHub");
  if (await page.locator("#login-github").count()) fail("GitHub offered on a server without it");
  await page.goto(base + "/");
  await page.locator("#landing-login").click();
  await page.waitForURL((u) => u.pathname === "/login");
  await page.locator("#login-form").waitFor();
  await shot(page, "login");

  // Wrong password: said beside the form, still logged out.
  await logIn(withPw, "wrong-pass-9");
  await page.locator("#login-error", { hasText: "wrong email or password" }).waitFor();
  if (await page.evaluate(() => localStorage.getItem("cresslet.token"))) fail("logged in with a wrong password");
  await shot(page, "login-wrong");
  console.log("wrong password refused");

  // Right one: logged in, on the projects page.
  await logIn(withPw, "first-pass-1");
  await page.waitForURL((u) => u.pathname === "/");
  await page.locator("#home").waitFor();
  if (!(await page.evaluate(() => localStorage.getItem("cresslet.token")))?.startsWith("clv_acct_")) fail("no session after the login");
  console.log("logged in with the password");

  // Settings: change it (the current one is needed).
  await page.goto(base + "/settings");
  await page.locator("#pw-text", { hasText: `You can log in with ${withPw}` }).waitFor();
  await page.locator("#pw-current").fill("not-it-123");
  await page.locator("#pw-new").fill("second-pass-2");
  await page.locator("#pw-save").click();
  await page.locator("#pw-error", { hasText: "current password is wrong" }).waitFor();
  if (!await page.evaluate(() => localStorage.getItem("cresslet.token"))) fail("a wrong current password logged the studio out");
  await page.locator("#pw-current").fill("first-pass-1");
  await page.locator("#pw-save").click();
  await page.getByText("Password changed").waitFor();
  await shot(page, "settings-password");
  console.log("password changed in Settings");

  // Log out, then the CLI login page: its Log in goes to /login and comes back.
  await page.locator("#logout-btn").click();
  await page.goto(base + "/cli");
  await page.locator("#cli-login-actions").getByRole("button", { name: "Log in" }).click();
  await page.waitForURL((u) => u.pathname === "/login");
  await logIn(withPw, "first-pass-1");
  await page.locator("#login-error", { hasText: "wrong email or password" }).waitFor();
  await logIn(withPw, "second-pass-2");
  await page.waitForURL((u) => u.pathname === "/cli");
  await page.locator("#cli-login-form").waitFor();
  console.log("CLI login page: back after the password login, with the new password");

  // An account without one sets it in Settings (logged in another way: its token).
  await page.locator("#cli-login-form").evaluate(() => localStorage.clear());
  const tok = (await create({ email: without })).token as string;
  await page.evaluate((t) => localStorage.setItem("cresslet.token", t), tok);
  await page.goto(base + "/settings");
  await page.locator("#pw-text", { hasText: `Set a password to also log in with ${without}` }).waitFor();
  if (await page.locator("#pw-current").count()) fail("asked for a current password it doesn't have");
  await page.locator("#pw-new").fill("brand-new-3");
  await page.locator("#pw-save").click();
  await page.locator("#pw-text", { hasText: `You can log in with ${without}` }).waitFor();
  await page.locator("#logout-btn").click();
  await page.goto(base + "/login");
  await logIn(without, "brand-new-3");
  await page.waitForURL((u) => u.pathname === "/");
  await page.locator("#home").waitFor();
  console.log("password set in Settings, then logged in with it");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", (e as Error).message);
  await page.screenshot({ path: "password-login-fail.png" });
} finally {
  await browser.close();
}
