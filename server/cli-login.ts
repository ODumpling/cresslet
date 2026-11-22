// CLI browser login: the CLI shows a code and opens the studio, the user (logged in there) types the code to
// approve it, and the CLI's poll gets a new account token. The code is typed, not in the link, so a link sent
// by someone else can't approve their login in one click. Pending logins live in memory (like GitHub OAuth state).
import { randomInt } from "node:crypto";
import { HttpError } from "./deploys.ts";
import { type Account, id, type Store } from "./store.ts";

const TTL = 10 * 60_000;
const INTERVAL = 2; // seconds between polls
const MAX_PENDING = 100_000;
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels (no words), nothing that reads as a digit

type Pending = { userCode: string; exp: number; approved?: { accountId: string; tokenId: string } };

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
      return {
        deviceCode,
        userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
        verificationUri: `${root}/cli`,
        expiresIn: TTL / 1000,
        interval: INTERVAL,
      };
    },

    /** The studio's user approves the code shown in their terminal, with a full-access token (`tokenId`). */
    approve(userCode: string, account: Account, tokenId: string) {
      sweep();
      const dc = byUser.get(normalize(userCode));
      const p = dc && pending.get(dc);
      if (!p || p.approved) throw new HttpError(404, "no login is waiting for that code: check it, or run `cresslet auth login` again", "not_found");
      p.approved = { accountId: account.id, tokenId };
    },

    async poll(deviceCode: string): Promise<{ status: "pending" } | { account: Account; token: string }> {
      const p = pending.get(deviceCode);
      if (!p || p.exp < Date.now()) throw new HttpError(400, "login expired, run login again", "expired_token");
      if (!p.approved) return { status: "pending" };
      pending.delete(deviceCode);
      byUser.delete(p.userCode);
      const { accountId, tokenId } = p.approved;
      const account = await store.accountById(accountId);
      // The approving token was revoked since (checked again after issuing, like POST /v1/me/tokens).
      const live = async () => (await store.tokens(accountId)).some((t) => t.id === tokenId);
      const gone = () => new HttpError(400, "login expired, run login again", "expired_token");
      if (!account || !await live()) throw gone();
      const { token, info } = await store.issueToken(account.id, { name: "CLI (browser login)" });
      if (!await live()) {
        await store.revokeToken(accountId, info.id);
        throw gone();
      }
      return { account, token };
    },
  };
}
