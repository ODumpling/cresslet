// Passwords for email + password login: scrypt, a random salt each, stored as `scrypt$N$r$p$salt$key` (base64).
import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from "node:crypto";

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

// 32 MiB and ~50-100 ms a hash: logins are rate limited (api.ts), so this bounds what they cost.
const N = 2 ** 15, R = 8, P = 1, KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

const derive = (password: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, len, { ...opts, maxmem: MAXMEM }, (e, key) => (e ? reject(e) : resolve(key))));

/** Why `password` can't be one, or null if it can. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "password required";
  if ([...password].length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// Checked against when there's no account (or no password): a miss takes as long as a wrong password.
let dummy: Promise<string> | undefined;

/** Whether `password` matches `hash`. No hash: false, after the same work as a wrong password. */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  const stored = hash ?? await (dummy ??= hashPassword(randomBytes(16).toString("hex")));
  const [alg, n, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const want = Buffer.from(key, "base64");
  const got = await derive(password, Buffer.from(salt, "base64"), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(got, want) && !!hash;
}

/**
 * The account's password hash, or null if it has none (or one set before its GitHub link). Stored as
 * `<GitHub id when set>:<hash>` (Store.setPasswordHash): a GitHub link by a server without passwords (a rollback)
 * doesn't drop the column, so a password set before the link must stop counting after it.
 */
export function accountPassword(a: { password_hash: string | null; github_id: number | null }): string | null {
  const s = a.password_hash, i = s?.indexOf(":") ?? -1;
  return s && i >= 0 && s.slice(0, i) === String(a.github_id ?? "") ? s.slice(i + 1) : null;
}
