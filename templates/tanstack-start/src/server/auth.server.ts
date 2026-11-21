// Email + password auth. Users live in `db`; sessions and rate-limit counters in `kv` (both from "cresslet").
// A session is a random token in an HttpOnly cookie; kv stores only its SHA-256, so a copy of the database holds no
// live sessions. Passwords: PBKDF2-SHA256 via Web Crypto (100k iterations is the most workerd allows).
import { db, kv } from "cresslet";
import { deleteCookie, getCookie, getRequestHeader, getRequestUrl, setCookie } from "@tanstack/react-start/server";
import { migrate } from "./db.server";

export type User = { id: number; email: string; name: string };

const COOKIE = "sid";
const SESSION_DAYS = 30;
const ITERATIONS = 100_000;

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !salt || !hash) return false;
  const want = unb64(hash);
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  let diff = want.length ^ got.length;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ (got[i] ?? 0);
  return diff === 0;
}

const sha256 = async (s: string) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
const sessionKey = async (token: string) => `session:${await sha256(token)}`;

export async function startSession(userId: number) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  await kv.set(await sessionKey(token), { userId }, { ttl: SESSION_DAYS * 86400 });
  setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: getRequestUrl().protocol === "https:",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function endSession() {
  const token = getCookie(COOKIE);
  if (token) await kv.delete(await sessionKey(token));
  deleteCookie(COOKIE, { path: "/" });
}

/** The signed-in user, or null. */
export async function currentUser(): Promise<User | null> {
  const token = getCookie(COOKIE);
  if (!token) return null;
  const session = await kv.get<{ userId: number }>(await sessionKey(token));
  if (!session) return null;
  await migrate();
  return db.first(db.sql<User>`SELECT id, email, name FROM users WHERE id = ${session.userId}`);
}

/** An error whose message is safe to show the user. */
export class UserError extends Error {}

/**
 * Counts an attempt and throws once there were more than `max` within `windowSec` (kv counters with a TTL): per client
 * IP, and 10x that for the whole app, a ceiling for when the client IP isn't known.
 */
export async function rateLimit(scope: string, max: number, windowSec: number) {
  const ip = getRequestHeader("cf-connecting-ip") ?? getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const checks: [string, number][] = [[`rl:${scope}:ip:${ip}`, max], [`rl:${scope}`, max * 10]];
  for (const [key, limit] of checks) {
    if ((await kv.incr(key, 1, { ttl: windowSec })) > limit) {
      throw new UserError("Too many attempts. Try again in a few minutes.");
    }
  }
}
