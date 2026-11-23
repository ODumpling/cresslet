// Workspace relay (/v1/workspace/relay): pairs a CLI MCP bridge (`cresslet connect`) with one open
// Cresslet Studio tab belonging to the same logged-in account, using a short one-time code, then
// relays validated JSON tool-call frames between them.
//
// Single-node only (v1): pending codes and active pairs live in memory on this process
// (docs/architecture.md#scaling-out). Cross-node relay routing is out of scope for v1.
import { randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { type Config, rootUrl } from "./config.ts";
import { ipKey, RateLimit } from "./limits.ts";
import { type Account, AccountDisabledError, ROLES, type Store, type Token } from "./store.ts";

const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels (no accidental words), no digit lookalikes
const DEFAULT_CODE_TTL_MS = 5 * 60_000;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const PRE_AUTH_MAX_BYTES = 8 * 1024;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 10_000;
const MAX_PAIRED = 1_000;
const MAX_SESSIONS_PER_ACCOUNT = 10;
const MAX_UNAUTH_GLOBAL = 200;
const MAX_UNAUTH_PER_IP = 20;
const DEFAULT_PING_MS = 30_000;
const DEFAULT_TOKEN_CHECK_MS = 60_000;
const MAX_ID_LEN = 128;

export interface RelayOptions {
  codeTtlMs?: number;
  authTimeoutMs?: number;
  pingMs?: number;
  tokenCheckMs?: number;
  cliStartsPer10Min?: number;
  studioClaimsPer10Min?: number;
  clock?: () => number;
}

interface Session {
  code: string;
  displayCode: string;
  exp: number;
  state: "pending" | "awaiting_approval" | "paired" | "closed";
  accountId: string;
  cliTokenId: string;
  agent: string;
  cliWs: WebSocket;
  studioWs?: WebSocket;
  studioTokenId?: string;
  projectName?: string;
  createdAt: number;
  lastActivity: number;
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z]/g, "");

const cleanLabel = (v: unknown, fallback: string, max = 64): string => {
  if (typeof v !== "string") return fallback;
  const s = v.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
  return s || fallback;
};

const rawByteLength = (data: RawData): number => {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.byteLength, 0);
  return data.byteLength;
};

const rawToString = (data: RawData): string => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
};

const httpReject = (socket: Duplex, status: number, text: string) => {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
};

const sendJson = (ws: WebSocket, msg: Record<string, unknown>) => {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.close(1008, "slow consumer");
    return false;
  }
  ws.send(JSON.stringify({ v: 1, ...msg }));
  return true;
};

const sendErrorAndClose = (ws: WebSocket, code: string, message: string, closeCode = 4000) => {
  sendJson(ws, { type: "error", code, message });
  ws.close(closeCode, code);
};

export function createRelay(cfg: Config, store: Store, opts: RelayOptions = {}) {
  const codeTtlMs = opts.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
  const authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const pingMs = opts.pingMs ?? DEFAULT_PING_MS;
  const tokenCheckMs = opts.tokenCheckMs ?? DEFAULT_TOKEN_CHECK_MS;
  const now = opts.clock ?? (() => Date.now());
  const studioOrigin = new URL(rootUrl(cfg)).origin;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const pending = new Map<string, Session>(); // normalized code → session (pending | awaiting_approval)
  const paired = new Set<Session>();
  const accountSessions = new Map<string, Set<Session>>();
  const unauthSockets = new Set<WebSocket>();
  const unauthByIp = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  const cliStarts = new RateLimit(opts.cliStartsPer10Min ?? 20, 10 * 60_000);
  const studioClaims = new RateLimit(opts.studioClaimsPer10Min ?? 10, 10 * 60_000);

  const clientIp = (req: IncomingMessage) => {
    const hdr = cfg.clientIpHeader ? req.headers[cfg.clientIpHeader.toLowerCase()] : undefined;
    const raw = Array.isArray(hdr) ? hdr[0] : hdr;
    return ipKey(raw?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown");
  };

  function trackAccount(session: Session) {
    let set = accountSessions.get(session.accountId);
    if (!set) {
      set = new Set();
      accountSessions.set(session.accountId, set);
    }
    set.add(session);
  }

  function untrackAccount(session: Session) {
    const set = accountSessions.get(session.accountId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) accountSessions.delete(session.accountId);
  }

  function closeSession(session: Session, code = 1000, reason = "closed") {
    if (session.state === "closed") return;
    session.state = "closed";
    if (pending.get(session.code) === session) pending.delete(session.code);
    paired.delete(session);
    untrackAccount(session);
    if (session.cliWs.readyState === WebSocket.OPEN || session.cliWs.readyState === WebSocket.CONNECTING) {
      session.cliWs.close(code, reason);
    }
    if (session.studioWs && (session.studioWs.readyState === WebSocket.OPEN || session.studioWs.readyState === WebSocket.CONNECTING)) {
      session.studioWs.close(code, reason);
    }
  }

  function sweepExpired() {
    const t = now();
    for (const s of pending.values()) {
      if (s.exp <= t) {
        sendErrorAndClose(s.cliWs, "expired", "Pairing code expired.", 4002);
        if (s.studioWs) sendErrorAndClose(s.studioWs, "expired", "Pairing code expired.", 4002);
        closeSession(s, 4002, "expired");
      }
    }
    const idleMs = cfg.limits.wsIdleMs;
    const maxMs = cfg.limits.wsMaxMs;
    for (const s of paired) {
      if ((idleMs > 0 && t - s.lastActivity > idleMs) || (maxMs > 0 && t - s.createdAt > maxMs)) {
        closeSession(s, 1000, "timeout");
      }
    }
  }

  async function verifyToken(raw: unknown): Promise<{ account: Account; token: Token } | null> {
    if (typeof raw !== "string") return null;
    if (!raw.startsWith("clv_acct_") && !raw.startsWith("clv_scoped_")) return null;
    let found: { account: Account; token: Token } | undefined;
    try {
      found = await store.useToken(raw);
    } catch (e) {
      if (e instanceof AccountDisabledError) return null;
      throw e;
    }
    if (!found) return null;
    // Account-wide deploy or admin token only (never read-only tokens, app-scoped tokens, or deploy keys).
    if (ROLES.indexOf(found.token.role) < ROLES.indexOf("deploy") || found.token.apps !== null) return null;
    return found;
  }

  async function tokensStillLive(accountId: string, tokenIds: string[]): Promise<boolean> {
    const account = await store.accountById(accountId);
    if (!account || account.disabled_at) return false;
    const live = new Set((await store.tokens(accountId)).map((t) => t.id));
    return tokenIds.every((tid) => live.has(tid));
  }

  function mintCode(): { code: string; displayCode: string } {
    let code: string;
    do code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    while (pending.has(code));
    return { code, displayCode: `${code.slice(0, 4)}-${code.slice(4)}` };
  }

  const pingTimer = setInterval(() => {
    sweepExpired();
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, pingMs);
  pingTimer.unref();

  const tokenTimer = setInterval(() => {
    void (async () => {
      for (const s of [...paired]) {
        if (s.state !== "paired") continue;
        const ids = s.studioTokenId ? [s.cliTokenId, s.studioTokenId] : [s.cliTokenId];
        const ok = await tokensStillLive(s.accountId, ids).catch(() => false);
        if (!ok && s.state === "paired") {
          sendErrorAndClose(s.cliWs, "unauthorized", "Session token revoked or account disabled.", 4001);
          if (s.studioWs) sendErrorAndClose(s.studioWs, "unauthorized", "Session token revoked or account disabled.", 4001);
          closeSession(s, 4001, "unauthorized");
        }
      }
    })();
  }, tokenCheckMs);
  tokenTimer.unref();

  function attachConnection(ws: WebSocket, ip: string, hasStudioOrigin: boolean) {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    unauthSockets.add(ws);
    unauthByIp.set(ip, (unauthByIp.get(ip) ?? 0) + 1);
    let authed = false;
    let handlingHello = false;
    let role: "cli" | "studio" | null = null;
    let session: Session | null = null;

    const releaseUnauth = () => {
      if (!unauthSockets.delete(ws)) return;
      const n = (unauthByIp.get(ip) ?? 1) - 1;
      if (n <= 0) unauthByIp.delete(ip);
      else unauthByIp.set(ip, n);
    };

    const authTimer = setTimeout(() => {
      if (!authed) sendErrorAndClose(ws, "auth_timeout", "Authentication timed out.", 4001);
    }, authTimeoutMs);
    authTimer.unref();

    ws.on("close", () => {
      clearTimeout(authTimer);
      releaseUnauth();
      if (!session || session.state === "closed") return;
      if (role === "studio" && session.state === "awaiting_approval" && session.studioWs === ws) {
        // Studio closed before deciding: revert to pending until TTL rather than killing the CLI.
        session.studioWs = undefined;
        session.studioTokenId = undefined;
        session.projectName = undefined;
        session.state = "pending";
        return;
      }
      closeSession(session, 1000, "peer disconnected");
    });

    ws.on("error", () => {
      clearTimeout(authTimer);
      releaseUnauth();
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendErrorAndClose(ws, "bad_frame", "Text JSON frames only.", 1003);
      if (!authed) {
        if (handlingHello) return sendErrorAndClose(ws, "bad_frame", "Unexpected frame before auth completed.", 1008);
        if (rawByteLength(data) > PRE_AUTH_MAX_BYTES) return sendErrorAndClose(ws, "too_large", "Auth message too large.", 1009);
        handlingHello = true;
        void handleHello(rawToString(data)).catch(() => {
          sendErrorAndClose(ws, "internal", "Internal error.", 1011);
        });
        return;
      }
      if (!session || session.state === "closed") return;
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawToString(data));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
        msg = parsed as Record<string, unknown>;
      } catch {
        return sendErrorAndClose(ws, "bad_frame", "Invalid JSON frame.", 1003);
      }

      if (role === "studio" && session.state === "awaiting_approval") {
        if (msg.type === "pair_decision" && typeof msg.allow === "boolean") {
          void handleDecision(session, msg.allow).catch(() => {
            if (session) closeSession(session, 1011, "internal");
          });
          return;
        }
        return sendErrorAndClose(ws, "bad_frame", "Expected pair_decision.", 1008);
      }

      if (session.state !== "paired") {
        // Ignore or reject frames while waiting for pairing.
        return sendErrorAndClose(ws, "not_paired", "Session is not paired yet.", 1008);
      }

      session.lastActivity = now();
      if (role === "cli") {
        if (msg.type === "tool_call") {
          if (typeof msg.id !== "string" || !msg.id || msg.id.length > MAX_ID_LEN) return sendErrorAndClose(ws, "bad_frame", "Invalid tool_call id.", 1008);
          if (typeof msg.name !== "string" || !msg.name || msg.name.length > 64) return sendErrorAndClose(ws, "bad_frame", "Invalid tool_call name.", 1008);
          if (msg.arguments !== undefined && (!msg.arguments || typeof msg.arguments !== "object" || Array.isArray(msg.arguments))) {
            return sendErrorAndClose(ws, "bad_frame", "Invalid tool_call arguments.", 1008);
          }
          if (session.studioWs) {
            sendJson(session.studioWs, { type: "tool_call", id: msg.id, name: msg.name, arguments: msg.arguments ?? {} });
          }
          return;
        }
        if (msg.type === "tool_cancel") {
          if (typeof msg.id !== "string" || !msg.id || msg.id.length > MAX_ID_LEN) return sendErrorAndClose(ws, "bad_frame", "Invalid tool_cancel id.", 1008);
          if (session.studioWs) sendJson(session.studioWs, { type: "tool_cancel", id: msg.id });
          return;
        }
        return sendErrorAndClose(ws, "bad_frame", "Unexpected frame from CLI.", 1008);
      }

      if (role === "studio") {
        if (msg.type === "tool_result") {
          if (typeof msg.id !== "string" || !msg.id || msg.id.length > MAX_ID_LEN) return sendErrorAndClose(ws, "bad_frame", "Invalid tool_result id.", 1008);
          if (typeof msg.text !== "string") return sendErrorAndClose(ws, "bad_frame", "Invalid tool_result text.", 1008);
          sendJson(session.cliWs, { type: "tool_result", id: msg.id, text: msg.text, ...(msg.error ? { error: true } : {}) });
          return;
        }
        return sendErrorAndClose(ws, "bad_frame", "Unexpected frame from studio.", 1008);
      }
    });

    async function handleHello(raw: string) {
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
        msg = parsed as Record<string, unknown>;
      } catch {
        return sendErrorAndClose(ws, "bad_frame", "Invalid hello JSON.", 1003);
      }
      if (msg.type !== "hello" || (msg.role !== "cli" && msg.role !== "studio")) {
        return sendErrorAndClose(ws, "bad_frame", "First frame must be hello with role cli or studio.", 1008);
      }
      if (msg.role === "studio" && !hasStudioOrigin) {
        return sendErrorAndClose(ws, "forbidden", "Studio connections require the studio origin.", 4003);
      }
      const verified = await verifyToken(msg.token);
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!verified) {
        return sendErrorAndClose(ws, "unauthorized", "Valid account-wide deploy or admin token required.", 4001);
      }
      const { account, token } = verified;
      sweepExpired();

      if (msg.role === "cli") {
        if (!await cliStarts.take(account.id, now())) {
          return sendErrorAndClose(ws, "rate_limited", "Too many pairing sessions started; wait a few minutes.", 4029);
        }
        if (pending.size >= MAX_PENDING || (accountSessions.get(account.id)?.size ?? 0) >= MAX_SESSIONS_PER_ACCOUNT) {
          return sendErrorAndClose(ws, "rate_limited", "Too many active relay sessions.", 4029);
        }
        const { code, displayCode } = mintCode();
        const t = now();
        const s: Session = {
          code,
          displayCode,
          exp: t + codeTtlMs,
          state: "pending",
          accountId: account.id,
          cliTokenId: token.id,
          agent: cleanLabel(msg.agent, "Desktop agent", 64),
          cliWs: ws,
          createdAt: t,
          lastActivity: t,
        };
        pending.set(code, s);
        trackAccount(s);
        authed = true;
        role = "cli";
        session = s;
        clearTimeout(authTimer);
        releaseUnauth();
        sendJson(ws, { type: "code", code: displayCode, expiresIn: Math.floor(codeTtlMs / 1000) });
        return;
      }

      // role === "studio"
      if (!await studioClaims.take(account.id, now())) {
        return sendErrorAndClose(ws, "rate_limited", "Too many pairing attempts; wait a few minutes.", 4029);
      }
      const rawCode = typeof msg.code === "string" ? normalizeCode(msg.code) : "";
      const s = rawCode ? pending.get(rawCode) : undefined;
      // Same error for missing, expired, already claimed, or another account's code (no cross-account oracle).
      if (!s || s.exp <= now() || s.accountId !== account.id || s.state !== "pending" || s.cliWs.readyState !== WebSocket.OPEN) {
        return sendErrorAndClose(ws, "not_found", "No agent is waiting for that code. Check the code or restart `cresslet connect`.", 4004);
      }
      if (paired.size >= MAX_PAIRED) {
        return sendErrorAndClose(ws, "rate_limited", "Relay capacity reached; try again soon.", 4029);
      }
      // Atomically reserve this pending session for this studio socket.
      s.state = "awaiting_approval";
      s.studioWs = ws;
      s.studioTokenId = token.id;
      s.projectName = cleanLabel(msg.projectName, "project", 100);
      authed = true;
      role = "studio";
      session = s;
      clearTimeout(authTimer);
      releaseUnauth();
      sendJson(ws, { type: "pair_request", agent: s.agent });
    }

    async function handleDecision(s: Session, allow: boolean) {
      if (s.state !== "awaiting_approval" || s.studioWs !== ws) return;
      if (!allow) {
        sendJson(s.cliWs, { type: "denied", message: "Connection denied in Cresslet Studio." });
        closeSession(s, 4003, "denied");
        return;
      }
      // Re-check expiry, both sockets, and token/account liveness before consuming the code.
      if (s.exp <= now()) {
        sendErrorAndClose(s.cliWs, "expired", "Pairing code expired.", 4002);
        sendErrorAndClose(ws, "expired", "Pairing code expired.", 4002);
        closeSession(s, 4002, "expired");
        return;
      }
      if (s.cliWs.readyState !== WebSocket.OPEN || ws.readyState !== WebSocket.OPEN) {
        closeSession(s, 1000, "peer disconnected");
        return;
      }
      const ids = s.studioTokenId ? [s.cliTokenId, s.studioTokenId] : [s.cliTokenId];
      if (!await tokensStillLive(s.accountId, ids)) {
        sendErrorAndClose(s.cliWs, "unauthorized", "Session token revoked or account disabled.", 4001);
        sendErrorAndClose(ws, "unauthorized", "Session token revoked or account disabled.", 4001);
        closeSession(s, 4001, "unauthorized");
        return;
      }
      if (s.state !== "awaiting_approval" || s.studioWs !== ws || s.cliWs.readyState !== WebSocket.OPEN || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      // Consume one-time code and transition to paired.
      pending.delete(s.code);
      s.state = "paired";
      s.lastActivity = now();
      paired.add(s);
      sendJson(s.cliWs, { type: "paired", projectName: s.projectName ?? "project" });
      sendJson(ws, { type: "paired", agent: s.agent });
    }
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== studioOrigin) {
      return httpReject(socket, 403, "Forbidden");
    }
    const ip = clientIp(req);
    if (unauthSockets.size >= MAX_UNAUTH_GLOBAL || (unauthByIp.get(ip) ?? 0) >= MAX_UNAUTH_PER_IP) {
      return httpReject(socket, 429, "Too Many Requests");
    }
    const hasStudioOrigin = origin === studioOrigin;
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachConnection(ws, ip, hasStudioOrigin);
    });
  }

  function close() {
    clearInterval(pingTimer);
    clearInterval(tokenTimer);
    for (const s of [...pending.values(), ...paired]) closeSession(s, 1001, "server shutting down");
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return {
    upgrade,
    close,
    /** Counts for diagnostics/tests. */
    stats: () => ({ pending: pending.size, paired: paired.size, unauth: unauthSockets.size }),
  };
}
