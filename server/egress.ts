// Egress allowlist for a sandbox. When an app has an allowlist, workerd's globalOutbound is this
// proxy (external service, `style = proxy`: requests arrive with absolute URLs, raw sockets arrive
// as CONNECT). Allowed requests are forwarded to public addresses only; everything else gets 403.
// Apps without an allowlist use workerd's own `allow = ["public"]` network instead, except under gVisor
// (no network in the sandbox): there this proxy runs with `allow = null`, any public host, raw sockets too.
import { lookup } from "node:dns";
import { BlockList, connect, isIP, type LookupFunction, type Socket } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { Agent, request } from "undici";

const HOST_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const MAX_EGRESS_HOSTS = 50;

/** Validates and normalizes an allowlist: exact hosts or `*.example.com` (subdomains only). */
export function normalizeEgress(allow: unknown): string[] {
  if (!Array.isArray(allow) || allow.length > MAX_EGRESS_HOSTS) {
    throw new Error(`allow must be an array of at most ${MAX_EGRESS_HOSTS} hostnames`);
  }
  const out = new Set<string>();
  for (const h of allow) {
    const host = typeof h === "string" ? h.trim().toLowerCase().replace(/\.$/, "") : "";
    if (!HOST_RE.test(host) || isIP(host)) throw new Error(`invalid host: ${String(h)} (use example.com or *.example.com)`);
    out.add(host);
  }
  return [...out];
}

export function egressAllows(allow: string[], hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return allow.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
}

// Same intent as workerd's "public": no loopback, private, link-local, CGNAT, multicast, reserved.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
// IPv6: only global unicast (2000::/3), minus its special-purpose / transition blocks
// (2001::/23 incl. Teredo, 2001:db8::/32 docs, 2002::/16 6to4 which can embed private IPv4).
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [net, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}
blocked.addSubnet("192.88.99.0", 24, "ipv4");
export function isPublicIp(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1]);
  const family = isIP(ip);
  if (family === 6) return global6.check(ip, "ipv6") && !blocked.check(ip, "ipv6");
  return family === 4 && !blocked.check(ip, "ipv4");
}

/** dns.lookup that only returns public addresses (checked at connect time: no DNS-rebinding window). */
export const publicLookup = (resolve = lookup): LookupFunction => (hostname, options, cb) => {
  resolve(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "", 0);
    const ok = (addrs as { address: string; family: number }[]).filter((a) => isPublicIp(a.address));
    if (!ok.length) return cb(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "EACCES" }), "", 0);
    if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof ok) => void)(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
};

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "expect"]);
/** Copy headers minus hop-by-hop ones, including those nominated by `Connection` (RFC 9110 7.6.1). */
function endToEnd(h: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const conn = new Set(String(h.connection ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k) && !conn.has(k) && k !== "host") out[k] = v;
  return out;
}
/** Per-app cap on concurrent outbound requests (bounds sockets/fds the control plane holds for one app). */
const MAX_INFLIGHT = 64;

export function createEgressProxy(
  /** null = any public host (gVisor sandboxes without an allowlist). */
  allow: string[] | null,
  log: (line: string) => void,
  connectLookup: LookupFunction = publicLookup(), // tests point it at a local upstream
): Server {
  // Bounded sockets: ≤ 32 origins × 4 connections, idle ones closed after 2s.
  const agent = new Agent({ connect: { lookup: connectLookup }, maxOrigins: 32, connections: 4, keepAliveTimeout: 2000, keepAliveMaxTimeout: 2000 });
  let inflight = 0;
  const deny = (res: ServerResponse, msg: string) => {
    log(`egress blocked: ${msg}`);
    res.writeHead(403, { "content-type": "text/plain" }).end(`Cresslet egress blocked: ${msg}`);
  };

  const server = createServer({ requireHostHeader: false }, async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return deny(res, `bad request target ${req.url}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return deny(res, url.protocol);
    const ip = url.hostname.replace(/^\[|\]$/g, "");
    // An IP literal never goes through connectLookup, so it's checked here.
    if (isIP(ip) && (allow || !isPublicIp(ip))) return deny(res, `${url.hostname} (${allow ? "IP literals are not allowed" : "not a public address"})`);
    if (allow && !egressAllows(allow, url.hostname)) return deny(res, `${url.hostname} is not in the allowlist`);
    if (inflight >= MAX_INFLIGHT) {
      log(`egress: more than ${MAX_INFLIGHT} concurrent requests, rejecting`);
      return void res.writeHead(503, { "content-type": "text/plain" }).end("Cresslet egress: too many concurrent requests");
    }

    const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
    const ac = new AbortController();
    res.once("close", () => ac.abort());
    inflight++;
    try {
      const up = await request(url, {
        method: req.method as "GET",
        headers: endToEnd(req.headers),
        body: hasBody ? req : null,
        dispatcher: agent,
        signal: ac.signal,
      });
      res.writeHead(up.statusCode, endToEnd(up.headers));
      // pipeline, not pipe: an upstream reset or a client abort mid-body must not throw unhandled.
      await pipeline(up.body, res);
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      if (ac.signal.aborted) return;
      const msg = (e as Error).message;
      if ((e as { code?: string }).code === "EACCES" || /non-public/.test(msg)) return deny(res, msg);
      log(`egress error: ${url.hostname}: ${msg}`);
      res.writeHead(502, { "content-type": "text/plain" }).end("Cresslet egress: upstream error");
    } finally {
      inflight--;
    }
  });
  // Raw TCP (cloudflare:sockets connect()) isn't available under an allowlist; without one (gVisor),
  // it's tunnelled to public addresses only, like workerd's own "public" network.
  // CONNECT sockets leave the HTTP server's connection tracking: closeAllConnections() (sandbox stop)
  // must close them too.
  const tunnels = new Set<Socket>();
  const closeAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => {
    closeAll();
    for (const t of tunnels) t.destroy();
  };
  server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    tunnels.add(socket);
    socket.once("close", () => tunnels.delete(socket));
    socket.on("error", () => socket.destroy());
    // Answer, then close both directions (end() alone would leave a socket the sandbox can hold open).
    const reply = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\ncontent-length: 0\r\n\r\n`);
      socket.destroySoon();
    };
    const forbid = (msg: string) => {
      log(`egress blocked: ${msg}`);
      reply("403 Forbidden");
    };
    if (allow) return forbid(`raw socket to ${req.url}`);
    const m = /^\[?([^\[\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? "");
    const port = Number(m?.[2]);
    if (!m || port < 1 || port > 65535) return forbid(`bad CONNECT target ${req.url}`);
    if (isIP(m[1]) && !isPublicIp(m[1])) return forbid(`raw socket to ${m[1]} (not a public address)`);
    if (inflight >= MAX_INFLIGHT) return reply("503 Service Unavailable");
    inflight++;
    let open = false;
    const up = connect({ host: m[1], port, lookup: connectLookup, allowHalfOpen: true });
    const done = () => {
      up.destroy();
      socket.destroy();
    };
    up.once("close", () => inflight--);
    up.once("connect", () => {
      open = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", (e) => {
      if (open) return done();
      const code = (e as { code?: string }).code;
      if (code === "EACCES" || /non-public/.test(e.message)) return forbid(e.message);
      log(`egress error: ${m[1]}: ${e.message}`);
      reply("502 Bad Gateway");
    });
    socket.on("close", done);
  });
  server.on("close", () => void agent.close());
  return server;
}
