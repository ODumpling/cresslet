// Workspace relay (/v1/workspace/relay): pairs a CLI MCP bridge (`cresslet connect`) with one open
// Cresslet Studio tab belonging to the same logged-in account, using a short one-time code, then
// relays validated JSON tool-call frames between them.
//
// Live Link v2 (#153): a code pairing can *remember* the agent (an agent credential: a CLI-made secret, only its hash
// here, bound to the account, the CLI token and the enrolling browser installation, with a grant for that project).
// After that, the owning tab of each open project keeps a *presence* socket (session cookie + the browser's install
// secret), and a remembered agent's socket (token + agent secret) *binds* to one granted, open project at a time and
// sends its tool calls there, one at a time, the whole tuple checked again before each. Switching projects needs a
// click in the target tab; Disconnect pauses a project until Resume; Forget revokes the credential.
//
// Single-node only (v1): pending codes, presences and bindings live in memory on this process
// (docs/architecture.md#scaling-out); credentials, grants, epochs and pauses are in the database.
import { randomBytes, randomInt } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { type Config, rootUrl, sessionCookieValue } from "./config.ts";
import { ipKey, RateLimit } from "./limits.ts";
import { type Account, AccountDisabledError, type AgentCredential, ROLES, type Store, type Token } from "./store.ts";

const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels (no accidental words), no digit lookalikes
const DEFAULT_CODE_TTL_MS = 5 * 60_000;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const PRE_AUTH_MAX_BYTES = 8 * 1024;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 10_000;
const MAX_PAIRED = 1_000;
const MAX_SESSIONS_PER_ACCOUNT = 10;
const MAX_UNAUTH_GLOBAL = 400;
// Sized for several tabs and agents behind one address reconnecting together (a server restart).
const MAX_UNAUTH_PER_IP = 64;
const MAX_PRESENCE_PER_ACCOUNT = 50;
const MAX_AGENTS_PER_ACCOUNT = 50;
const MAX_CREDENTIALS_PER_HELLO = 20;
const DEFAULT_SWITCH_TTL_MS = 5 * 60_000;
const OUTCOME_UNKNOWN = "Studio disconnected while this tool call was running. Do not assume whether a write or commit completed; reconnect and check.";
const DEFAULT_PING_MS = 30_000;
const DEFAULT_TOKEN_CHECK_MS = 60_000;
const DEFAULT_IDLE_MS = 60 * 60_000; // 1 hour idle (separate from app-sandbox 10m wsIdleMs)
const DEFAULT_MAX_MS = 12 * 60 * 60_000; // 12 hours max session
const MAX_ID_LEN = 128;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface RelayOptions {
  codeTtlMs?: number;
  authTimeoutMs?: number;
  pingMs?: number;
  tokenCheckMs?: number;
  idleMs?: number;
  maxMs?: number;
  authAttemptsPer10Min?: number;
  /** Failed authentications per IP: throttled harder, and kept in the database (they survive a restart). */
  authFailuresPer10Min?: number;
  cliStartsPer10Min?: number;
  studioClaimsPer10Min?: number;
  /** Reconnects of one remembered agent (not the code-pairing budget). */
  agentConnectsPer10Min?: number;
  /** Presence sockets opened per account (tabs reconnecting). */
  presenceConnectsPer10Min?: number;
  switchTtlMs?: number;
  clock?: () => number;
}

interface Session {
  /** Set by a v2 CLI: remembering it stores this hash (the secret stays in the CLI). */
  enroll?: { secretHash: string; instanceId: string };
  /** The studio's proven browser installation and project (a v2 studio), for Remember. */
  studioInstall?: string;
  studioProjectId?: string;
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

/** The owning tab of one open project (v2). */
interface Presence {
  ws: WebSocket;
  gen: number;
  accountId: string;
  tokenId: string;
  installId: string;
  projectId: string;
  /** installId + ":" + projectId: what agents bind to (opaque to them). */
  handle: string;
  projectName: string;
  app: string | null;
  /** Disconnect until Resume (the tab's own record or the server's). */
  paused: boolean;
  /** The tab's own driver (the built-in builder, or a code-paired agent): agents can't bind meanwhile. */
  occupiedBy: string | null;
  binding: Binding | null;
  /** Agents refused because another one is bound (the tab offers Take over). */
  waiting: Set<Agent>;
  /** Switch requests to this project, waiting for the user's click. */
  switches: Set<SwitchRequest>;
}

/** A remembered agent's socket (v2): `cresslet connect` with token + agent secret(s). */
interface Agent {
  ws: WebSocket;
  gen: number;
  accountId: string;
  tokenId: string;
  instanceId: string;
  label: string;
  credentials: Map<string, AgentCredential>;
  /** The project it asked to bind to (bound again when its tab comes back). */
  want: string | null;
  binding: Binding | null;
  switchReq: SwitchRequest | null;
  /** Calls whose authorization check hasn't finished, and those cancelled meanwhile. */
  checking: Set<string>;
  cancelled: Set<string>;
}

interface Binding {
  agent: Agent;
  presence: Presence;
  credentialId: string;
  handle: string;
  epoch: number;
  /** The call the tab is running (one at a time). */
  inflight: string | null;
  /** The user accepted a switch away: new calls get a retryable error until the inflight one settles. */
  switching: SwitchRequest | null;
}

interface SwitchRequest {
  id: string;
  agent: Agent;
  target: Presence;
  credentialId: string;
  exp: number;
  accepted: boolean;
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
    ws.terminate();
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
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const now = opts.clock ?? (() => Date.now());
  const studioOrigin = new URL(rootUrl(cfg)).origin;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const pending = new Map<string, Session>(); // normalized code → session (pending | awaiting_approval)
  const paired = new Set<Session>();
  const accountSessions = new Map<string, Set<Session>>();
  const unauthSockets = new Set<WebSocket>();
  const unauthByIp = new Map<string, number>();
  const alive = new WeakMap<WebSocket, boolean>();

  // Pre-auth, per IP: bounded (it caps token lookups) but sized for several tabs and agents behind one address.
  const authAttempts = new RateLimit(opts.authAttemptsPer10Min ?? 200, 10 * 60_000);
  // Failed authentications, per IP: counted apart and throttled harder, in the database (a restart doesn't reset them).
  const authFailures = new RateLimit(opts.authFailuresPer10Min ?? 30, 10 * 60_000, { hits: store, bucket: "relay_auth_fail" });
  const failBlocked = new Map<string, number>(); // ip → until
  // Code pairing (enrolment) budgets.
  const cliStarts = new RateLimit(opts.cliStartsPer10Min ?? 20, 10 * 60_000);
  const studioClaims = new RateLimit(opts.studioClaimsPer10Min ?? 10, 10 * 60_000);
  // Reconnects with a valid credential, and tabs' presence: their own budgets (normal recovery isn't enrolment).
  const agentConnects = new RateLimit(opts.agentConnectsPer10Min ?? 120, 10 * 60_000);
  const presenceConnects = new RateLimit(opts.presenceConnectsPer10Min ?? 300, 10 * 60_000);
  const switchTtlMs = opts.switchTtlMs ?? DEFAULT_SWITCH_TTL_MS;

  // v2 state.
  const presences = new Map<string, Presence>(); // accountId|handle → the owning tab's socket
  const presencesByAccount = new Map<string, Set<Presence>>();
  const agentsByAccount = new Map<string, Set<Agent>>();
  /** Who was last bound to a project (accountId|handle → instanceId): it gets it back first when the tab returns. */
  const lastBound = new Map<string, string>();
  /**
   * The project each agent process (accountId|instanceId) confirmed (its user's or its own explicit choice): moving
   * away from it needs a click in the target tab, bound or not (a reconnect keeps it).
   */
  const pinned = new Map<string, string>();
  let generation = 0;

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
    for (const s of paired) {
      if ((idleMs > 0 && t - s.lastActivity > idleMs) || (maxMs > 0 && t - s.createdAt > maxMs)) {
        sendErrorAndClose(s.cliWs, "timeout", "Relay session timed out.", 4008);
        if (s.studioWs) sendErrorAndClose(s.studioWs, "timeout", "Relay session timed out.", 4008);
        closeSession(s, 4008, "timeout");
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

  async function noteAuthFailure(ip: string) {
    if (!await authFailures.take(ip, now()).catch(() => true)) failBlocked.set(ip, now() + 10 * 60_000);
  }
  const authBlocked = (ip: string) => {
    const until = failBlocked.get(ip);
    if (until === undefined) return false;
    if (until > now()) return true;
    failBlocked.delete(ip);
    return false;
  };

  // ---------------------------------------------------------------- v2: presence, agents, bindings
  const pkey = (accountId: string, handle: string) => `${accountId}|${handle}`;
  const isOpen = (ws: WebSocket) => ws.readyState === WebSocket.OPEN;
  const projectUrl = (handle: string) => `${rootUrl(cfg).replace(/\/+$/, "")}/p/${encodeURIComponent(handle.slice(handle.indexOf(":") + 1))}`;
  function addTo<V>(m: Map<string, Set<V>>, k: string, v: V) {
    let set = m.get(k);
    if (!set) m.set(k, (set = new Set()));
    set.add(v);
  }
  function removeFrom<V>(m: Map<string, Set<V>>, k: string, v: V) {
    const set = m.get(k);
    if (!set) return;
    set.delete(v);
    if (!set.size) m.delete(k);
  }

  /** What the tab shows: who's bound, who's waiting (Take over), switch requests (Use with), paused. */
  function presenceState(p: Presence) {
    sendJson(p.ws, {
      type: "state",
      paused: p.paused,
      binding: p.binding ? { agent: p.binding.agent.label, credentialId: p.binding.credentialId, instanceId: p.binding.agent.instanceId } : null,
      waiting: [...p.waiting].map((a) => ({ agent: a.label, instanceId: a.instanceId })),
      switches: [...p.switches].filter((r) => !r.accepted).map((r) => ({
        id: r.id, agent: r.agent.label, credentialId: r.credentialId, from: r.agent.binding?.presence.projectName ?? null,
      })),
    });
  }

  /** Ends a binding: the tab stops its call, the agent hears why (its call's outcome is unknown unless the tab said). */
  function endBinding(b: Binding, reason: string, message: string) {
    if (b.agent.binding === b) b.agent.binding = null;
    if (b.presence.binding === b) b.presence.binding = null;
    if (b.switching) {
      // An accepted switch waiting for this binding's call: it lapses with it (else it'd block every later one).
      const req = b.switching;
      b.switching = null;
      dropSwitch(req, "closed");
    }
    // Unbound first: the agent then sends nothing more under this binding (its queued calls aren't run).
    sendJson(b.agent.ws, { type: "unbound", handle: b.handle, reason, message, projectName: b.presence.projectName });
    if (b.inflight) {
      const id = b.inflight;
      b.inflight = null;
      sendJson(b.presence.ws, { type: "tool_cancel", id });
      sendJson(b.agent.ws, {
        type: "tool_result", id, error: true, code: "outcome_unknown",
        text: reason === "not_open" ? OUTCOME_UNKNOWN : `${message} This call was cancelled while running: do not assume whether a write or commit completed; check before retrying.`,
      });
    }
    presenceState(b.presence);
  }

  type BindCheck =
    | { ok: true; presence: Presence; credentialId: string; epoch: number }
    | { ok: false; code: string; message: string; projectName?: string; url?: string };

  /** Whether `agent` may bind to `handle` now (the whole tuple, from the database). `ignoreBusy`: a switch the user clicks. */
  async function checkBind(agent: Agent, handle: string, ignoreBusy = false): Promise<BindCheck> {
    let found: { cid: string; name: string; epoch: number } | undefined;
    for (const cid of agent.credentials.keys()) {
      const g = await store.agentGrant(cid, handle);
      if (g) {
        found = { cid, name: g.project_name, epoch: Number(g.epoch) };
        break;
      }
    }
    if (!found) {
      return { ok: false, code: "no_grant", message: "This agent isn't approved for that project. Ask the user to open it in Cresslet Studio and click Connect agent → Allow." };
    }
    if (!await store.agentCredentialLive(found.cid, now())) {
      return { ok: false, code: "revoked", message: "This agent was forgotten or expired in Cresslet Studio: pair again with a code." };
    }
    const p = presences.get(pkey(agent.accountId, handle));
    const name = p?.projectName ?? found.name;
    if (!p || !isOpen(p.ws)) {
      return { ok: false, code: "not_open", projectName: name, url: projectUrl(handle), message: `Project ${name} isn't open in Cresslet Studio. Ask the user to open it (${projectUrl(handle)}, in the browser it was approved in).` };
    }
    if (p.paused || await store.agentPaused(agent.accountId, handle)) {
      p.paused = true;
      return { ok: false, code: "paused", projectName: name, message: `Disconnected in Cresslet Studio: project ${name} is paused until the user clicks Resume in its tab.` };
    }
    if (!ignoreBusy && p.occupiedBy) {
      return { ok: false, code: "in_use", projectName: name, message: `Project ${name} is in use by ${p.occupiedBy} in Cresslet Studio. Try again when it has finished.` };
    }
    if (!ignoreBusy && p.binding && p.binding.agent !== agent) {
      return { ok: false, code: "in_use", projectName: name, message: `Project ${name} is in use by ${p.binding.agent.label}. Ask the user to click Take over in its Studio tab.` };
    }
    return { ok: true, presence: p, credentialId: found.cid, epoch: found.epoch };
  }

  function establish(agent: Agent, p: Presence, credentialId: string, epoch: number, extra: Record<string, unknown> = {}) {
    if (agent.binding?.presence === p) {
      agent.binding.epoch = epoch;
    } else {
      const b: Binding = { agent, presence: p, credentialId, handle: p.handle, epoch, inflight: null, switching: null };
      agent.binding = b;
      p.binding = b;
    }
    agent.want = p.handle;
    p.waiting.delete(agent);
    lastBound.set(pkey(p.accountId, p.handle), agent.instanceId);
    sendJson(agent.ws, { type: "bound", handle: p.handle, projectName: p.projectName, epoch, credentialId, ...extra });
    presenceState(p);
  }

  /** Binds `agent` to `handle` (its pin), or says why not; refused for another agent's binding, it waits for Take over. */
  async function bind(agent: Agent, handle: string, { quiet = false, extra = {} as Record<string, unknown> } = {}) {
    agent.want = handle;
    const r = await checkBind(agent, handle);
    if (!isOpen(agent.ws) || agent.want !== handle) return;
    if (r.ok) {
      const p = r.presence;
      // Checked again after the awaits: nothing may have changed meanwhile.
      if (presences.get(pkey(agent.accountId, handle)) === p && isOpen(p.ws) && !p.paused && !p.occupiedBy && (!p.binding || p.binding.agent === agent)) {
        if (agent.binding && agent.binding.presence !== p) return; // bound elsewhere meanwhile: a switch decides
        return establish(agent, p, r.credentialId, r.epoch, extra);
      }
      return bind(agent, handle, { quiet, extra });
    }
    if (r.code === "in_use") {
      const p = presences.get(pkey(agent.accountId, handle));
      if (p && p.binding && p.binding.agent !== agent && !p.waiting.has(agent)) {
        p.waiting.add(agent);
        presenceState(p);
      }
    }
    if (!quiet || r.code !== "not_open") {
      sendJson(agent.ws, { type: "bind_error", handle, code: r.code, message: r.message, ...(r.projectName ? { projectName: r.projectName } : {}), ...(r.url ? { url: r.url } : {}) });
    }
  }

  /** A project's tab came back, was resumed, or is free again: agents pinned to it bind (the one last bound first). */
  function rebindWanters(p: Presence) {
    if (p.binding || p.paused || p.occupiedBy) return;
    const last = lastBound.get(pkey(p.accountId, p.handle));
    const wanters = [...agentsByAccount.get(p.accountId) ?? []].filter((a) => a.want === p.handle && !a.binding && isOpen(a.ws));
    wanters.sort((a, b) => Number(b.instanceId === last) - Number(a.instanceId === last));
    if (wanters[0]) void bind(wanters[0], p.handle, { quiet: true });
  }

  async function listProjects(agent: Agent) {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const cid of agent.credentials.keys()) {
      for (const g of await store.agentGrants(cid)) {
        if (seen.has(g.project_handle)) continue;
        const p = presences.get(pkey(agent.accountId, g.project_handle));
        if (!p || !isOpen(p.ws)) continue; // granted + open only
        seen.add(g.project_handle);
        const other = p.binding && p.binding.agent !== agent ? p.binding.agent.label : p.occupiedBy;
        out.push({
          handle: g.project_handle, name: p.projectName, app: p.app, credentialId: cid, paused: p.paused,
          current: agent.binding?.handle === g.project_handle, ...(other ? { inUse: other } : {}),
        });
      }
    }
    return out;
  }

  function dropSwitch(req: SwitchRequest, reason: string) {
    req.target.switches.delete(req);
    if (req.agent.switchReq === req) req.agent.switchReq = null;
    presenceState(req.target);
    sendJson(req.agent.ws, { type: "switch_expired", handle: req.target.handle, projectName: req.target.projectName, reason });
  }

  /** `use_project` away from the current pin: the target tab asks the user (Use with <agent>); nothing moves until then. */
  async function requestSwitch(agent: Agent, handle: string) {
    const r = await checkBind(agent, handle, true);
    if (!isOpen(agent.ws)) return;
    if (!r.ok) {
      return sendJson(agent.ws, { type: "bind_error", handle, code: r.code, message: r.message, ...(r.projectName ? { projectName: r.projectName } : {}), ...(r.url ? { url: r.url } : {}) });
    }
    if (agent.switchReq) {
      if (agent.switchReq.target === r.presence && !agent.switchReq.accepted) {
        return sendJson(agent.ws, { type: "switch_pending", handle, projectName: r.presence.projectName, expiresIn: Math.max(0, Math.round((agent.switchReq.exp - now()) / 1000)) });
      }
      if (agent.switchReq.accepted) return sendJson(agent.ws, { type: "bind_error", handle, code: "switching", message: "A switch is already under way; retry in a moment." });
      dropSwitch(agent.switchReq, "replaced");
    }
    const req: SwitchRequest = { id: randomBytes(9).toString("base64url"), agent, target: r.presence, credentialId: r.credentialId, exp: now() + switchTtlMs, accepted: false };
    agent.switchReq = req;
    r.presence.switches.add(req);
    presenceState(r.presence);
    sendJson(agent.ws, { type: "switch_pending", handle, projectName: r.presence.projectName, expiresIn: Math.round(switchTtlMs / 1000) });
  }

  /** The user clicked Use with <agent> and the old binding's call has settled: move. */
  async function completeSwitch(req: SwitchRequest) {
    const a = req.agent, p = req.target;
    p.switches.delete(req);
    if (a.switchReq === req) a.switchReq = null;
    const old = a.binding;
    if (!isOpen(a.ws) || !isOpen(p.ws) || presences.get(pkey(p.accountId, p.handle)) !== p || !a.credentials.has(req.credentialId)) {
      if (old?.switching === req) old.switching = null;
      presenceState(p);
      return sendJson(a.ws, { type: "switch_expired", handle: p.handle, projectName: p.projectName, reason: "closed" });
    }
    const from = old?.presence.projectName ?? null;
    if (old && old.presence !== p) {
      old.switching = null; // this switch: settled here, not dropped by endBinding
      await store.bumpAgentEpoch(a.accountId, old.handle, old.credentialId);
      endBinding(old, "switched", `Switched to project ${p.projectName}.`);
      sendJson(old.presence.ws, { type: "notice", text: `${a.label} switched to ${p.projectName}.` });
    }
    const g = await store.agentGrant(req.credentialId, p.handle);
    // Checked again after the awaits: closed, paused or taken meanwhile, the switch lapses (nothing binds).
    if (!g || !isOpen(a.ws) || !isOpen(p.ws) || presences.get(pkey(p.accountId, p.handle)) !== p) {
      return sendJson(a.ws, { type: "switch_expired", handle: p.handle, projectName: p.projectName, reason: "closed" });
    }
    if (p.paused || p.occupiedBy) {
      return sendJson(a.ws, { type: "switch_expired", handle: p.handle, projectName: p.projectName, reason: p.paused ? "paused" : "in_use" });
    }
    if (p.binding && p.binding.agent !== a) {
      // The user's click in this tab hands it over (like Take over).
      const other = p.binding;
      other.agent.want = null;
      endBinding(other, "taken_over", `Project ${p.projectName} was taken over by ${a.label} in Cresslet Studio.`);
      void store.bumpAgentEpoch(other.agent.accountId, other.handle, other.credentialId);
    }
    pinned.set(pkey(a.accountId, a.instanceId), p.handle);
    establish(a, p, req.credentialId, Number(g.epoch), { switched: true, ...(from ? { from } : {}) });
    sendJson(p.ws, { type: "notice", text: from ? `${a.label} switched here from ${from}.` : `${a.label} connected.` });
  }

  function closePresence(p: Presence) {
    const key = pkey(p.accountId, p.handle);
    if (presences.get(key) !== p) return; // a newer socket (another generation) took over: not ours to clear
    presences.delete(key);
    removeFrom(presencesByAccount, p.accountId, p);
    if (p.binding) endBinding(p.binding, "not_open", `Project ${p.projectName} isn't open in Cresslet Studio.`);
    for (const req of [...p.switches]) {
      if (req.agent.binding?.switching === req) req.agent.binding.switching = null;
      dropSwitch(req, "closed");
    }
    p.waiting.clear();
  }

  function closeAgent(a: Agent) {
    const set = agentsByAccount.get(a.accountId);
    if (!set?.has(a)) return;
    removeFrom(agentsByAccount, a.accountId, a);
    if (a.binding) endBinding(a.binding, "closed", "Agent disconnected.");
    if (a.switchReq) {
      a.switchReq.target.switches.delete(a.switchReq);
      presenceState(a.switchReq.target);
      a.switchReq = null;
    }
    for (const p of presencesByAccount.get(a.accountId) ?? []) {
      if (p.waiting.delete(a)) presenceState(p);
    }
  }

  /** A credential revoked or expired: its bindings end now and its socket closes when it has no other. */
  function dropCredential(a: Agent, cid: string, message: string) {
    if (!a.credentials.delete(cid)) return;
    if (a.binding?.credentialId === cid) {
      a.want = null;
      endBinding(a.binding, "revoked", message);
    }
    if (a.switchReq?.credentialId === cid) dropSwitch(a.switchReq, "revoked");
    if (!a.credentials.size) {
      sendJson(a.ws, { type: "revoked", credentials: [cid] });
      sendErrorAndClose(a.ws, "unauthorized_agent", message, 4001);
    } else sendJson(a.ws, { type: "revoked", credentials: [cid] });
  }

  const onAgentsRevoked = (accountId: string, ids: string[]) => {
    for (const a of [...agentsByAccount.get(accountId) ?? []]) {
      for (const cid of ids) dropCredential(a, cid, "This agent was forgotten in Cresslet Studio: pair again with a code.");
    }
  };
  const onTokensRevoked = (accountId: string, tokenIds: string[] | null) => {
    const hit = (tid: string | undefined) => !!tid && (tokenIds === null || tokenIds.includes(tid));
    const msg = "Session token revoked or account disabled.";
    for (const s of [...(accountSessions.get(accountId) ?? [])]) {
      if (hit(s.cliTokenId) || hit(s.studioTokenId)) {
        sendErrorAndClose(s.cliWs, "unauthorized", msg, 4001);
        if (s.studioWs) sendErrorAndClose(s.studioWs, "unauthorized", msg, 4001);
        closeSession(s, 4001, "unauthorized");
      }
    }
    for (const p of [...presencesByAccount.get(accountId) ?? []]) if (hit(p.tokenId)) sendErrorAndClose(p.ws, "unauthorized", msg, 4001);
    for (const a of [...agentsByAccount.get(accountId) ?? []]) if (hit(a.tokenId)) sendErrorAndClose(a.ws, "unauthorized", msg, 4001);
  };
  store.events.on("agents-revoked", onAgentsRevoked);
  store.events.on("tokens-revoked", onTokensRevoked);

  function sweepV2() {
    const t = now();
    for (const set of presencesByAccount.values()) {
      for (const p of set) for (const req of [...p.switches]) if (!req.accepted && req.exp <= t) dropSwitch(req, "expired");
    }
  }

  function mintCode(): { code: string; displayCode: string } {
    let code: string;
    do code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    while (pending.has(code));
    return { code, displayCode: `${code.slice(0, 4)}-${code.slice(4)}` };
  }

  const pingTimer = setInterval(() => {
    sweepExpired();
    sweepV2();
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

  let checkingTokens = false;
  const tokenTimer = setInterval(() => {
    if (checkingTokens || (paired.size === 0 && presencesByAccount.size === 0 && agentsByAccount.size === 0)) return;
    checkingTokens = true;
    void (async () => {
      try {
        const byAccount = new Map<string, Session[]>();
        for (const s of paired) {
          if (s.state !== "paired") continue;
          const list = byAccount.get(s.accountId) ?? [];
          list.push(s);
          byAccount.set(s.accountId, list);
        }
        for (const [accountId, sessions] of byAccount) {
          const account = await store.accountById(accountId).catch(() => undefined);
          const liveIds = account && !account.disabled_at
            ? new Set((await store.tokens(accountId).catch(() => [])).map((t) => t.id))
            : new Set<string>();
          for (const s of sessions) {
            if (s.state !== "paired") continue;
            const ok = liveIds.has(s.cliTokenId) && (!s.studioTokenId || liveIds.has(s.studioTokenId));
            if (!ok) {
              sendErrorAndClose(s.cliWs, "unauthorized", "Session token revoked or account disabled.", 4001);
              if (s.studioWs) sendErrorAndClose(s.studioWs, "unauthorized", "Session token revoked or account disabled.", 4001);
              closeSession(s, 4001, "unauthorized");
            }
          }
        }
        // v2: tabs' sessions, agents' tokens, and their credentials (revoked, or expired after 90 days unused).
        const accounts = new Set([...presencesByAccount.keys(), ...agentsByAccount.keys()]);
        for (const accountId of accounts) {
          const account = await store.accountById(accountId).catch(() => undefined);
          const liveIds = account && !account.disabled_at
            ? new Set((await store.tokens(accountId).catch(() => [])).map((t) => t.id))
            : new Set<string>();
          const msg = "Session token revoked or account disabled.";
          for (const p of [...presencesByAccount.get(accountId) ?? []]) if (!liveIds.has(p.tokenId)) sendErrorAndClose(p.ws, "unauthorized", msg, 4001);
          for (const a of [...agentsByAccount.get(accountId) ?? []]) {
            if (!liveIds.has(a.tokenId)) {
              sendErrorAndClose(a.ws, "unauthorized", msg, 4001);
              continue;
            }
            for (const cid of [...a.credentials.keys()]) {
              if (!await store.agentCredentialLive(cid, now()).catch(() => true)) {
                dropCredential(a, cid, "This remembered agent was forgotten or expired (unused for 90 days): pair again with a code.");
              }
            }
          }
        }
      } finally {
        checkingTokens = false;
      }
    })();
  }, tokenCheckMs);
  tokenTimer.unref();

  /** `studioSession`: the studio's session cookie (a studio-origin upgrade only): the studio's hello needs no token. */
  function attachConnection(ws: WebSocket, ip: string, hasStudioOrigin: boolean, studioSession?: string) {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    unauthSockets.add(ws);
    unauthByIp.set(ip, (unauthByIp.get(ip) ?? 0) + 1);
    let authed = false;
    let handlingHello = false;
    let deciding = false;
    let role: "cli" | "studio" | null = null;
    let session: Session | null = null;
    /** A v2 socket (presence or agent) once authenticated. */
    let v2: { onMessage(msg: Record<string, unknown>): void; onClose(): void } | null = null;

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
      if (v2) return v2.onClose();
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
      if (!v2 && (!session || session.state === "closed")) return;
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawToString(data));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
        msg = parsed as Record<string, unknown>;
      } catch {
        return sendErrorAndClose(ws, "bad_frame", "Invalid JSON frame.", 1003);
      }
      if (v2) return v2.onMessage(msg);
      if (!session) return;

      if (role === "studio" && session.state === "awaiting_approval") {
        if (msg.type === "pair_decision" && typeof msg.allow === "boolean") {
          if (deciding) return;
          deciding = true;
          void handleDecision(session, msg.allow, msg.remember === true).catch(() => {
            if (session && session.studioWs === ws) closeSession(session, 1011, "internal");
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
      if (msg.type !== "hello" || (msg.role !== "cli" && msg.role !== "studio" && msg.role !== "presence" && msg.role !== "agent")) {
        return sendErrorAndClose(ws, "bad_frame", "First frame must be hello with role cli, studio, presence or agent.", 1008);
      }
      if ((msg.role === "studio" || msg.role === "presence") && !hasStudioOrigin) {
        return sendErrorAndClose(ws, "forbidden", "Studio connections require the studio origin.", 4003);
      }
      if (authBlocked(ip)) {
        return sendErrorAndClose(ws, "rate_limited", "Too many failed connection attempts; wait a few minutes.", 4029);
      }
      if (!await authAttempts.take(ip, now())) {
        return sendErrorAndClose(ws, "rate_limited", "Too many connection attempts; wait a few minutes.", 4029);
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      const fromStudio = msg.role === "studio" || msg.role === "presence";
      const verified = await verifyToken(fromStudio && studioSession ? studioSession : msg.token);
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!verified) {
        await noteAuthFailure(ip);
        return sendErrorAndClose(ws, "unauthorized", "Valid account-wide deploy or admin token required.", 4001);
      }
      const { account, token } = verified;
      sweepExpired();

      const done = () => {
        authed = true;
        clearTimeout(authTimer);
        releaseUnauth();
      };
      if (msg.role === "presence") {
        // The browser's own session (the HttpOnly cookie), never a token in the hello: a CLI token can't pose as a tab.
        if (!studioSession) return sendErrorAndClose(ws, "unauthorized", "Studio presence needs the Studio's session.", 4001);
        return helloPresence(msg, account, token, done);
      }
      if (msg.role === "agent") return helloAgent(msg, account, token, done);

      if (msg.role === "cli") {
        if (!await cliStarts.take(account.id, now())) {
          return sendErrorAndClose(ws, "rate_limited", "Too many pairing sessions started; wait a few minutes.", 4029);
        }
        if (ws.readyState !== WebSocket.OPEN) return;
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
        // A v2 CLI offers to be remembered: only its secret's hash comes here.
        const enroll = msg.enroll as { secretHash?: unknown; instanceId?: unknown } | undefined;
        if (enroll && typeof enroll === "object" && typeof enroll.secretHash === "string" && /^[0-9a-f]{64}$/.test(enroll.secretHash)
          && typeof enroll.instanceId === "string" && ID_RE.test(enroll.instanceId)) {
          s.enroll = { secretHash: enroll.secretHash, instanceId: enroll.instanceId };
        }
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
      if (ws.readyState !== WebSocket.OPEN) return;
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
      // A v2 studio proves its browser installation (Remember this agent binds the credential to it).
      const install = msg.install as { id?: unknown; secret?: unknown } | undefined;
      if (s.enroll && install && typeof install === "object" && typeof install.id === "string" && ID_RE.test(install.id)
        && typeof install.secret === "string" && SECRET_RE.test(install.secret) && typeof msg.projectId === "string" && ID_RE.test(msg.projectId)) {
        if (await store.proveInstall(account.id, install.id, install.secret)) {
          s.studioInstall = install.id;
          s.studioProjectId = msg.projectId;
        }
        if (s.state !== "awaiting_approval" || s.studioWs !== ws) return;
      }
      sendJson(ws, { type: "pair_request", agent: s.agent, canRemember: !!s.studioInstall });
    }

    async function handleDecision(s: Session, allow: boolean, remember = false) {
      if (s.state !== "awaiting_approval" || s.studioWs !== ws) return;
      if (!allow) {
        sendJson(s.cliWs, { type: "denied", message: "Connection denied in Cresslet Studio." });
        closeSession(s, 4003, "denied");
        return;
      }
      const ids = s.studioTokenId ? [s.cliTokenId, s.studioTokenId] : [s.cliTokenId];
      if (!await tokensStillLive(s.accountId, ids)) {
        if (s.state === "awaiting_approval" && s.studioWs === ws) {
          sendErrorAndClose(s.cliWs, "unauthorized", "Session token revoked or account disabled.", 4001);
          sendErrorAndClose(ws, "unauthorized", "Session token revoked or account disabled.", 4001);
          closeSession(s, 4001, "unauthorized");
        }
        return;
      }
      // Re-check ownership, expiry, capacity, and both sockets after async token check.
      if (s.state !== "awaiting_approval" || s.studioWs !== ws || s.cliWs.readyState !== WebSocket.OPEN || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (s.exp <= now()) {
        sendErrorAndClose(s.cliWs, "expired", "Pairing code expired.", 4002);
        sendErrorAndClose(ws, "expired", "Pairing code expired.", 4002);
        closeSession(s, 4002, "expired");
        return;
      }
      if (paired.size >= MAX_PAIRED) {
        sendErrorAndClose(s.cliWs, "rate_limited", "Relay capacity reached; try again soon.", 4029);
        sendErrorAndClose(ws, "rate_limited", "Relay capacity reached; try again soon.", 4029);
        closeSession(s, 4029, "rate_limited");
        return;
      }
      if (remember && s.enroll && s.studioInstall && s.studioProjectId) {
        // Remembered: the agent gets a credential and a grant for this project, and reconnects with them (v2).
        pending.delete(s.code);
        const handle = `${s.studioInstall}:${s.studioProjectId}`;
        const cred = await store.createAgentCredential({
          accountId: s.accountId, cliTokenId: s.cliTokenId, installId: s.studioInstall, secretHash: s.enroll.secretHash,
          label: s.agent, handle, projectName: s.projectName ?? "project",
        });
        sendJson(s.cliWs, { type: "enrolled", credentialId: cred.id, handle, projectName: s.projectName ?? "project" });
        sendJson(ws, { type: "enrolled", agent: s.agent, credentialId: cred.id });
        closeSession(s, 1000, "enrolled");
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

    /** The owning tab of an open project: session cookie + the browser's install secret. */
    async function helloPresence(msg: Record<string, unknown>, account: Account, token: Token, done: () => void) {
      const install = msg.install as { id?: unknown; secret?: unknown } | undefined;
      const installId = typeof install?.id === "string" && ID_RE.test(install.id) ? install.id : null;
      const secret = typeof install?.secret === "string" && SECRET_RE.test(install.secret) ? install.secret : null;
      const projectId = typeof msg.projectId === "string" && ID_RE.test(msg.projectId) ? msg.projectId : null;
      if (!installId || !secret || !projectId) return sendErrorAndClose(ws, "bad_frame", "Presence needs install {id, secret} and projectId.", 1008);
      if (!await presenceConnects.take(account.id, now())) {
        return sendErrorAndClose(ws, "rate_limited", "Too many Studio reconnects; wait a few minutes.", 4029);
      }
      if (!await store.proveInstall(account.id, installId, secret)) {
        await noteAuthFailure(ip);
        return sendErrorAndClose(ws, "unauthorized", "This browser's installation secret doesn't match.", 4001);
      }
      if (!isOpen(ws)) return;
      const handle = `${installId}:${projectId}`;
      const key = pkey(account.id, handle);
      const old = presences.get(key);
      if ((presencesByAccount.get(account.id)?.size ?? 0) - (old ? 1 : 0) >= MAX_PRESENCE_PER_ACCOUNT) {
        return sendErrorAndClose(ws, "rate_limited", "Too many open projects for this account.", 4029);
      }
      // Effective pause: the tab's own record or the server's.
      const localPause = msg.paused === true;
      const serverPause = await store.agentPaused(account.id, handle);
      if (localPause && !serverPause) {
        // Disconnected while offline (the tab recorded it, the server never heard): calls made before it never run.
        await store.setAgentPause(account.id, handle, true);
        await store.bumpAgentEpoch(account.id, handle);
      }
      if (!isOpen(ws)) return;
      // A new presence for the same project replaces a stale one (its close handler then finds it isn't current).
      const replaced = presences.get(key);
      if (replaced) {
        closePresence(replaced);
        sendErrorAndClose(replaced.ws, "replaced", "This project's Studio connection was replaced by a newer one.", 4009);
      }
      const p: Presence = {
        ws, gen: ++generation, accountId: account.id, tokenId: token.id, installId, projectId, handle,
        projectName: cleanLabel(msg.projectName, "project", 100),
        app: typeof msg.app === "string" && msg.app ? cleanLabel(msg.app, "", 100) || null : null,
        paused: localPause || serverPause, occupiedBy: typeof msg.occupiedBy === "string" ? cleanLabel(msg.occupiedBy, "Studio", 64) : null,
        binding: null, waiting: new Set(), switches: new Set(),
      };
      presences.set(key, p);
      addTo(presencesByAccount, account.id, p);
      done();
      v2 = {
        onMessage: (m) => void presenceFrame(p, m).catch(() => sendErrorAndClose(ws, "internal", "Internal error.", 1011)),
        onClose: () => closePresence(p),
      };
      sendJson(ws, { type: "presence_ok", handle, paused: p.paused });
      presenceState(p);
      rebindWanters(p);
    }

    async function presenceFrame(p: Presence, msg: Record<string, unknown>) {
      if (presences.get(pkey(p.accountId, p.handle)) !== p) return; // replaced: frames from an older generation are dropped
      switch (msg.type) {
        case "tool_result": {
          if (typeof msg.id !== "string" || !msg.id || msg.id.length > MAX_ID_LEN || typeof msg.text !== "string") {
            return sendErrorAndClose(ws, "bad_frame", "Invalid tool_result.", 1008);
          }
          const b = p.binding;
          if (!b || b.inflight !== msg.id) return; // not this binding's call (ended meanwhile): dropped
          b.inflight = null;
          sendJson(b.agent.ws, { type: "tool_result", id: msg.id, text: msg.text, ...(msg.error ? { error: true } : {}) });
          if (b.switching) await completeSwitch(b.switching);
          return;
        }
        case "occupied": {
          // The tab's own driver (the built-in builder, a code-paired agent), or null: free again.
          p.occupiedBy = typeof msg.by === "string" && msg.by ? cleanLabel(msg.by, "Studio", 64) : null;
          if (!p.occupiedBy) rebindWanters(p);
          return;
        }
        case "rename": {
          p.projectName = cleanLabel(msg.projectName, p.projectName, 100);
          if (typeof msg.app === "string") p.app = cleanLabel(msg.app, "", 100) || null;
          return;
        }
        case "pause": {
          // Disconnect: the binding ends now, calls made before it never run (epoch), binds are refused until Resume.
          p.paused = true;
          if (p.binding) endBinding(p.binding, "paused", `Disconnected in Cresslet Studio: project ${p.projectName} is paused until the user clicks Resume in its tab.`);
          for (const req of [...p.switches]) dropSwitch(req, "paused");
          p.waiting.clear();
          await store.setAgentPause(p.accountId, p.handle, true);
          await store.bumpAgentEpoch(p.accountId, p.handle);
          sendJson(ws, { type: "paused" });
          presenceState(p);
          return;
        }
        case "resume": {
          // Server first (acked), then the tab clears its own record.
          await store.setAgentPause(p.accountId, p.handle, false);
          p.paused = false;
          sendJson(ws, { type: "resumed" });
          presenceState(p);
          rebindWanters(p);
          return;
        }
        case "grant": {
          // Connect agent → Allow, for a remembered agent of this browser: only the Studio can approve a project.
          const cid = typeof msg.credentialId === "string" ? msg.credentialId : "";
          const cred = (await store.agentCredentials(p.accountId)).find((c) => c.id === cid);
          if (!cred || cred.browser_install_id !== p.installId) {
            return sendJson(ws, { type: "error", code: "not_found", message: "No such remembered agent in this browser." });
          }
          await store.addAgentGrant(cid, p.handle, p.projectName);
          sendJson(ws, { type: "granted", credentialId: cid });
          for (const a of agentsByAccount.get(p.accountId) ?? []) {
            if (a.credentials.has(cid) && !a.binding && (a.want === p.handle || a.want === null)) {
              // An agent with nothing bound gets this project as its pin; one that asked for it before binds now.
              pinned.set(pkey(a.accountId, a.instanceId), p.handle);
              void bind(a, p.handle, { quiet: true, extra: { approved: true } });
              break;
            }
          }
          return;
        }
        case "forget": {
          // This browser's agents (those that can reach this tab); others from Settings → Connected agents.
          const cid = typeof msg.credentialId === "string" ? msg.credentialId : "";
          const cred = (await store.agentCredentials(p.accountId)).find((c) => c.id === cid);
          if (!cred || cred.browser_install_id !== p.installId) return sendJson(ws, { type: "forgotten", credentialId: cid, ok: false });
          const revoked = await store.revokeAgentCredentials(p.accountId, [cid]);
          sendJson(ws, { type: "forgotten", credentialId: cid, ok: revoked.length > 0 });
          return;
        }
        case "switch_accept":
        case "switch_decline": {
          const req = [...p.switches].find((r) => r.id === msg.id && !r.accepted);
          if (!req) return;
          if (msg.type === "switch_decline") return dropSwitch(req, "declined");
          if (req.exp <= now()) return dropSwitch(req, "expired");
          req.accepted = true;
          presenceState(p);
          const old = req.agent.binding;
          if (old && old.presence !== p && old.inflight) {
            old.switching = req; // settles when its call's result comes in
            return;
          }
          return completeSwitch(req);
        }
        case "take_over": {
          const a = [...p.waiting].find((x) => x.instanceId === msg.instanceId);
          if (!a || !isOpen(a.ws)) return;
          p.waiting.delete(a);
          if (p.binding) {
            const other = p.binding;
            await store.bumpAgentEpoch(other.agent.accountId, other.handle, other.credentialId);
            other.agent.want = null;
            endBinding(other, "taken_over", `Project ${p.projectName} was taken over by ${a.label} in Cresslet Studio.`);
          }
          if (a.binding && a.binding.presence !== p) {
            await store.bumpAgentEpoch(a.accountId, a.binding.handle, a.binding.credentialId);
            endBinding(a.binding, "switched", `Switched to project ${p.projectName}.`);
          }
          pinned.set(pkey(a.accountId, a.instanceId), p.handle);
          return bind(a, p.handle, { extra: { approved: true } });
        }
        default:
          return sendErrorAndClose(ws, "bad_frame", "Unexpected frame from studio.", 1008);
      }
    }

    /** A remembered agent: token + its credential secret(s) + a per-process instance id. */
    async function helloAgent(msg: Record<string, unknown>, account: Account, token: Token, done: () => void) {
      const instanceId = typeof msg.instanceId === "string" && ID_RE.test(msg.instanceId) ? msg.instanceId : null;
      const list = Array.isArray(msg.credentials) ? msg.credentials.slice(0, MAX_CREDENTIALS_PER_HELLO) : [];
      if (!instanceId || !list.length) return sendErrorAndClose(ws, "bad_frame", "Agent hello needs instanceId and credentials.", 1008);
      const credentials = new Map<string, AgentCredential>();
      const revoked: string[] = [];
      for (const c of list as { id?: unknown; secret?: unknown }[]) {
        if (!c || typeof c.id !== "string" || !ID_RE.test(c.id) || typeof c.secret !== "string" || !SECRET_RE.test(c.secret)) continue;
        const cred = await store.useAgentCredential(c.id, c.secret, account.id, token.id, now());
        if (cred) credentials.set(cred.id, cred);
        else revoked.push(c.id);
      }
      if (!isOpen(ws)) return;
      if (!credentials.size) {
        await noteAuthFailure(ip);
        sendJson(ws, { type: "revoked", credentials: revoked });
        return sendErrorAndClose(ws, "unauthorized_agent", "This remembered agent was forgotten, expired, or belongs to another login: pair again with a code.", 4001);
      }
      // Its own reconnect budget, keyed on a verified credential (not one anyone could name).
      if (!await agentConnects.take(credentials.keys().next().value!, now())) {
        return sendErrorAndClose(ws, "rate_limited", "Too many reconnects; wait a few minutes.", 4029);
      }
      // The same process reconnecting replaces its own stale socket.
      for (const a of [...agentsByAccount.get(account.id) ?? []]) {
        if (a.instanceId === instanceId && [...a.credentials.keys()].some((k) => credentials.has(k))) {
          closeAgent(a);
          sendErrorAndClose(a.ws, "replaced", "Replaced by a newer connection from this agent.", 4009);
        }
      }
      if ((agentsByAccount.get(account.id)?.size ?? 0) >= MAX_AGENTS_PER_ACCOUNT) {
        return sendErrorAndClose(ws, "rate_limited", "Too many connected agents for this account.", 4029);
      }
      const a: Agent = {
        ws, gen: ++generation, accountId: account.id, tokenId: token.id, instanceId, label: cleanLabel(msg.agent, "Desktop agent", 64),
        credentials, want: null, binding: null, switchReq: null, checking: new Set(), cancelled: new Set(),
      };
      addTo(agentsByAccount, account.id, a);
      done();
      v2 = {
        onMessage: (m) => void agentFrame(a, m).catch(() => sendErrorAndClose(ws, "internal", "Internal error.", 1011)),
        onClose: () => closeAgent(a),
      };
      sendJson(ws, { type: "ready", credentials: [...credentials.keys()], revoked, tokenId: token.id, projects: await listProjects(a) });
      if (typeof msg.bind === "string" && msg.bind.length <= 200) {
        // Its pin (a reconnect, or a restart that restored it); `confirmed`: the user (or it, explicitly) chose it.
        const key = pkey(a.accountId, instanceId);
        if (msg.confirmed === true && !pinned.has(key)) pinned.set(key, msg.bind);
        await bind(a, pinned.get(key) ?? msg.bind, { quiet: msg.quiet === true });
      }
    }

    async function agentFrame(a: Agent, msg: Record<string, unknown>) {
      if (!agentsByAccount.get(a.accountId)?.has(a)) return; // replaced
      switch (msg.type) {
        case "list":
          return void sendJson(ws, { type: "projects", projects: await listProjects(a) });
        case "bind": {
          if (typeof msg.handle !== "string" || !msg.handle || msg.handle.length > 200) return sendErrorAndClose(ws, "bad_frame", "Invalid bind.", 1008);
          const handle = msg.handle, pin = pinned.get(pkey(a.accountId, a.instanceId));
          if (a.binding?.handle === handle || (!a.binding && pin === handle)) {
            // use_project(<current>): the pending switch is withdrawn.
            if (a.switchReq) dropSwitch(a.switchReq, "withdrawn");
            if (msg.confirm === true) pinned.set(pkey(a.accountId, a.instanceId), handle);
            return bind(a, handle);
          }
          // Away from a confirmed pin (bound now or not): the target tab asks the user.
          if (pin) return requestSwitch(a, handle);
          // Not confirmed yet (picked automatically, never acted on): the agent may choose another freely, if it can bind
          // there (else it keeps the one it has).
          if (a.binding) {
            const r = await checkBind(a, handle);
            if (!r.ok) {
              return sendJson(ws, { type: "bind_error", handle, code: r.code, message: r.message, ...(r.projectName ? { projectName: r.projectName } : {}), ...(r.url ? { url: r.url } : {}) });
            }
            if (a.binding) endBinding(a.binding, "switched", "Switched project before confirming this one.");
          }
          if (a.switchReq) dropSwitch(a.switchReq, "withdrawn");
          if (msg.confirm === true) pinned.set(pkey(a.accountId, a.instanceId), handle);
          return bind(a, handle);
        }
        case "confirm": {
          // confirm_project: the automatically picked project, confirmed.
          if (a.binding && a.binding.handle === msg.handle) pinned.set(pkey(a.accountId, a.instanceId), a.binding.handle);
          return;
        }
        case "tool_call": {
          if (typeof msg.id !== "string" || !msg.id || msg.id.length > MAX_ID_LEN) return sendErrorAndClose(ws, "bad_frame", "Invalid tool_call id.", 1008);
          if (typeof msg.name !== "string" || !msg.name || msg.name.length > 64) return sendErrorAndClose(ws, "bad_frame", "Invalid tool_call name.", 1008);
          if (msg.arguments !== undefined && (!msg.arguments || typeof msg.arguments !== "object" || Array.isArray(msg.arguments))) {
            return sendErrorAndClose(ws, "bad_frame", "Invalid tool_call arguments.", 1008);
          }
          const id = msg.id;
          const fail = (code: string, text: string) => void sendJson(ws, { type: "tool_result", id, error: true, code, text });
          const b = a.binding;
          if (!b) return fail("not_bound", "Not connected to a Studio project.");
          if (msg.handle !== b.handle) return fail("stale_binding", "This call was made for another project: not run.");
          if (msg.epoch !== b.epoch) return fail("stale_epoch", "Cancelled in Studio (Disconnect, Take over or a project switch since this call was made): not run.");
          if (b.switching) return fail("switching", "Switching projects: retry this call in a moment.");
          if (b.inflight || a.checking.size) return fail("busy", "Another tool call is still running in Studio: wait for it.");
          a.checking.add(id);
          // The whole tuple again, from the database, before this dispatch.
          const [live, grant, paused, cliToken, studioToken] = await Promise.all([
            store.agentCredentialLive(b.credentialId, now()),
            store.agentGrant(b.credentialId, b.handle),
            store.agentPaused(a.accountId, b.handle),
            store.tokenLive(a.accountId, a.tokenId),
            store.tokenLive(b.presence.accountId, b.presence.tokenId),
          ]).finally(() => a.checking.delete(id));
          // Cancelled meanwhile: never sent to the tab; the result says so (the agent waits for this id's result).
          if (a.cancelled.delete(id)) return fail("cancelled", "Cancelled.");
          if (!cliToken) return sendErrorAndClose(ws, "unauthorized", "Session token revoked or account disabled.", 4001);
          if (!studioToken) {
            sendErrorAndClose(b.presence.ws, "unauthorized", "Session token revoked or account disabled.", 4001);
            return fail("not_bound", `Project ${b.presence.projectName} isn't connected any more (its Studio session ended): not run.`);
          }
          if (a.binding !== b || b.presence.binding !== b || !isOpen(b.presence.ws)) return fail("not_bound", `Project ${b.presence.projectName} isn't connected any more: not run.`);
          if (!live) {
            dropCredential(a, b.credentialId, "This agent was forgotten or expired in Cresslet Studio: pair again with a code.");
            return fail("revoked", "This agent was forgotten or expired in Cresslet Studio: not run.");
          }
          if (!grant || Number(grant.epoch) !== b.epoch) return fail("stale_epoch", "Cancelled in Studio (Disconnect or a project switch since this call was made): not run.");
          if (paused || b.presence.paused) return fail("paused", `Disconnected in Cresslet Studio: project ${b.presence.projectName} is paused until the user clicks Resume.`);
          if (b.switching) return fail("switching", "Switching projects: retry this call in a moment.");
          if (b.inflight) return fail("busy", "Another tool call is still running in Studio: wait for it.");
          b.inflight = id;
          sendJson(b.presence.ws, { type: "tool_call", id, name: msg.name, arguments: msg.arguments ?? {} });
          return;
        }
        case "tool_cancel": {
          if (typeof msg.id !== "string" || !msg.id || msg.id.length > MAX_ID_LEN) return sendErrorAndClose(ws, "bad_frame", "Invalid tool_cancel id.", 1008);
          if (a.checking.has(msg.id)) a.cancelled.add(msg.id);
          else if (a.binding?.inflight === msg.id) sendJson(a.binding.presence.ws, { type: "tool_cancel", id: msg.id });
          return;
        }
        default:
          return sendErrorAndClose(ws, "bad_frame", "Unexpected frame from agent.", 1008);
      }
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
    const studioSession = hasStudioOrigin ? sessionCookieValue(cfg, req.headers.cookie) : undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachConnection(ws, ip, hasStudioOrigin, studioSession);
    });
  }

  function close() {
    clearInterval(pingTimer);
    clearInterval(tokenTimer);
    for (const s of [...pending.values(), ...paired]) closeSession(s, 1001, "server shutting down");
    store.events.off("agents-revoked", onAgentsRevoked);
    store.events.off("tokens-revoked", onTokensRevoked);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return {
    upgrade,
    close,
    /** Counts for diagnostics/tests. */
    stats: () => ({
      pending: pending.size, paired: paired.size, unauth: unauthSockets.size,
      presence: [...presencesByAccount.values()].reduce((n, set) => n + set.size, 0),
      agents: [...agentsByAccount.values()].reduce((n, set) => n + set.size, 0),
      bound: [...presences.values()].filter((p) => p.binding).length,
    }),
    /** An account's open projects (v2 presence), for tests and diagnostics. */
    presence: (accountId: string) => [...presencesByAccount.get(accountId) ?? []].map((p) => ({
      handle: p.handle, projectName: p.projectName, paused: p.paused, agent: p.binding?.agent.label ?? null,
    })),
  };
}
