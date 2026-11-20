// Browser e2e: an app's WebSocket server (WebSocketPair) in the studio preview. Text, binary, subprotocol, closes
// both ways, a refused upgrade; saving a server file closes open sockets (1012) and clients can reconnect.
// Run: start the server (npm run dev), then: cd tests/e2e && node websocket.mjs [screenshot dir]
import { chromium } from "@playwright/test";
const base = process.env.CRESSLET_URL ?? "http://localhost:8787";
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const APP = `// A WebSocket echo server.
const boot = crypto.randomUUID().slice(0, 8);

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/ws") {
      if (req.headers.get("upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.send("welcome " + boot + " " + url.search);
      server.addEventListener("message", (e) => {
        if (e.data === "bye") server.close(4000, "bye yourself");
        else server.send(typeof e.data === "string" ? "echo " + e.data : e.data);
      });
      server.addEventListener("close", (e) => console.log("server saw close " + e.code + " " + e.reason));
      const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
      const headers = offered.includes("chat") ? { "sec-websocket-protocol": "chat" } : {};
      return new Response(null, { status: 101, webSocket: client, headers });
    }
    return Response.json({ boot });
  },
};
`;

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const term = page.locator(".xterm-rows");
const waitFor = async (fn, what, tries = 150) => {
  for (let i = 0; ; i++) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (i > tries) throw new Error(`never saw ${what}:\n${await term.innerText().catch(() => "")}`);
    await page.waitForTimeout(200);
  }
};
const frame = async () => (await page.locator("#preview").elementHandle()).contentFrame();
// Replaces (or appends to) server/index.ts in the editor; the dev server restarts the app's server.
const editServer = async (text, append = false) => {
  await page.locator('#tree button[data-path="server/index.ts"]').click();
  await page.locator("#editor .cm-content").click();
  await page.keyboard.press(append ? "ControlOrMeta+End" : "ControlOrMeta+A");
  await page.keyboard.insertText(text);
};
const boot = async () => (await (await frame()).evaluate(() => fetch("/api/boot").then((r) => r.json()))).boot;
try {
  await page.goto(base + "/");
  await page.getByRole("button", { name: /vanilla/i }).click();
  await page.waitForURL(/#\/p\//);
  await page.frameLocator("#preview").getByRole("heading", { name: "Hello from Cresslet" }).waitFor({ timeout: 120000 });
  await waitFor(async () => /dev server on port/.test(await term.innerText()), "the dev server");
  console.log("preview rendered");
  await editServer(APP);
  const boot1 = await waitFor(boot, "the new server");
  console.log("ws server up, boot", boot1);

  // Round trip: subprotocol, text, binary (ArrayBuffer and Blob), server-initiated close.
  const f = await frame();
  const roundTrip = await f.evaluate(() => new Promise((resolve, reject) => {
    const events = [];
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?room=1`, ["chat", "other"]);
    ws.binaryType = "arraybuffer";
    ws.onerror = () => reject(new Error("socket error"));
    ws.onopen = () => {
      events.push({ open: ws.protocol });
      ws.send("hi");
      ws.send(new Uint8Array([1, 2, 3]));
      ws.send(new Blob(["blob"]));
      ws.send("bye");
    };
    ws.onmessage = (e) => events.push(typeof e.data === "string" ? e.data.replace(/^welcome \w+/, "welcome") : [...new Uint8Array(e.data)]);
    ws.onclose = (e) => resolve({ events, code: e.code, reason: e.reason, wasClean: e.wasClean });
  }));
  assert(same(roundTrip, {
    events: [{ open: "chat" }, "welcome ?room=1", "echo hi", [1, 2, 3], [98, 108, 111, 98]],
    code: 4000, reason: "bye yourself", wasClean: true,
  }), `round trip: ${JSON.stringify(roundTrip)}`);
  console.log("round trip:", JSON.stringify(roundTrip));

  // Client close reaches the app's server end; HTTP still works alongside.
  const clientClose = await f.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket("/api/ws");
    ws.onmessage = () => ws.close(1000, "done here");
    ws.onclose = async (e) => resolve({ code: e.code, api: (await (await fetch("/api/x")).json()).boot.length });
  }));
  assert(same(clientClose, { code: 1000, api: 8 }), `client close: ${JSON.stringify(clientClose)}`);
  await waitFor(async () => /\[server\] server saw close 1000 done here/.test(await term.innerText()), "the server end's close");
  console.log("client close reached the server");

  // A refused upgrade (no WebSocketPair): error, then close 1006, like a browser.
  const refused = await f.evaluate(() => new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket("/api/nope");
    ws.onopen = () => events.push("open");
    ws.onerror = () => events.push("error");
    ws.onclose = (e) => resolve({ events, code: e.code });
  }));
  assert(same(refused, { events: ["error"], code: 1006 }), `refused: ${JSON.stringify(refused)}`);
  console.log("refused upgrade:", JSON.stringify(refused));

  // Worker restart: an open socket gets close 1012; reconnecting reaches the new server.
  await f.evaluate(() => new Promise((resolve) => {
    const ws = (window.__ws = new WebSocket("/api/ws"));
    window.__closed = null;
    ws.onmessage = (e) => ((window.__welcome = e.data), resolve());
    ws.onclose = (e) => (window.__closed = { code: e.code, reason: e.reason, wasClean: e.wasClean });
  }));
  await editServer("\n// v2\n", true);
  const closed = await waitFor(() => f.evaluate(() => window.__closed), "the open socket's close");
  await waitFor(async () => (await boot()) !== boot1, "the restarted server");
  assert(same(closed, { code: 1012, reason: "server restarting", wasClean: true }), `restart close: ${JSON.stringify(closed)}`);
  const welcome2 = await f.evaluate(() => new Promise((resolve, reject) => {
    const ws = new WebSocket("/api/ws");
    ws.onerror = () => reject(new Error("reconnect failed"));
    ws.onmessage = (e) => (ws.close(), resolve(e.data));
  }));
  const boot2 = welcome2.split(" ")[1];
  assert(boot2 && boot2 !== boot1, `reconnect reached the old server: ${welcome2}`);
  console.log("worker restart: close", JSON.stringify(closed), "→ reconnected to boot", boot2, "(was", boot1 + ")");
  assert(/GET \/api\/ws 101/.test(await term.innerText()), "dev log shows the 101");
  await page.screenshot({ path: (process.argv[2] ?? ".") + "/websocket.png" });
  console.log("PASS");
} catch (e) {
  process.exitCode = 1;
  console.log("FAIL", e.message);
  await page.screenshot({ path: (process.argv[2] ?? ".") + "/websocket-fail.png" });
  console.log(await term.innerText().catch(() => ""));
} finally {
  console.log(logs.slice(-30).join("\n"));
  await browser.close();
}
