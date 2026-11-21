// CLI browser login: the CLI asks for a code and opens the studio, the user (logged in there) approves it,
// and the CLI's poll gets a new account token. Pending logins live in memory (like GitHub OAuth state).
import { randomInt } from "node:crypto";
import { HttpError } from "./deploys.ts";
import { type Account, id, type Store } from "./store.ts";

const TTL = 10 * 60_000;
const INTERVAL = 2; // seconds between polls
const MAX_PENDING = 10_000;
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels (no words), nothing that reads as a digit

type Pending = { userCode: string; exp: number; accountId?: string };

const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z]/g, "");

export function cliLogin(store: Store) {
  const pending = new Map<string, Pending>(); // device code (the CLI's secret) → login
  const byUser = new Map<string, string>(); // user code (normalized) → device code

  function sweep() {
    const now = Date.now();
    for (const [dc, p] of pending) {
      if (p.exp < now) {
        pending.delete(dc);
        byUser.delete(p.userCode);
      }
    }
  }

  return {
    start(root: string) {
      sweep();
      if (pending.size >= MAX_PENDING) throw new HttpError(429, "too many logins in progress, try again soon", "rate_limited");
      let userCode: string;
      do userCode = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      while (byUser.has(userCode));
      const deviceCode = id("cli", 24);
      pending.set(deviceCode, { userCode, exp: Date.now() + TTL });
      byUser.set(userCode, deviceCode);
      const shown = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
      return {
        deviceCode,
        userCode: shown,
        verificationUri: `${root}/#/cli?code=${shown}`,
        expiresIn: TTL / 1000,
        interval: INTERVAL,
      };
    },

    /** The studio's user approves the code shown in their terminal. */
    approve(userCode: string, account: Account) {
      sweep();
      const dc = byUser.get(normalize(userCode));
      const p = dc && pending.get(dc);
      if (!p || p.accountId) throw new HttpError(404, "code not found or expired: run the login again", "not_found");
      p.accountId = account.id;
    },

    async poll(deviceCode: string): Promise<{ status: "pending" } | { account: Account; token: string }> {
      const p = pending.get(deviceCode);
      if (!p || p.exp < Date.now()) throw new HttpError(400, "login expired, run login again", "expired_token");
      if (!p.accountId) return { status: "pending" };
      pending.delete(deviceCode);
      byUser.delete(p.userCode);
      const account = store.accountById(p.accountId);
      if (!account) throw new HttpError(400, "account not found", "expired_token");
      return { account, token: (await store.issueToken(account.id, { name: "CLI (browser login)" })).token };
    },
  };
}
