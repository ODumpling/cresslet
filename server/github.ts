// GitHub OAuth: web flow (studio) and device flow (CLI, proxied so the client secret stays here).
import type { Config } from "./config.ts";
import { HttpError } from "./deploys.ts";
import { type Account, AccountDisabledError, id, type Store } from "./store.ts";

const SCOPE = "read:user user:email";
const STATE_TTL = 10 * 60_000;
const CODE_TTL = 60_000;

type GithubUser = { id: number; login: string; email: string | null };

export type Login = { account: Account; token: string };

export function github(cfg: Config, store: Store) {
  const gh = cfg.github!;
  const states = new Map<string, number>(); // OAuth state → expiry
  const codes = new Map<string, { token: string; account: Account; exp: number }>(); // one-time studio codes

  const sweep = <V>(m: Map<string, V>, exp: (v: V) => number) => {
    const now = Date.now();
    for (const [k, v] of m) if (exp(v) < now) m.delete(k);
  };

  /** Form POST to github.com (OAuth endpoints), JSON back. */
  async function oauth(path: string, params: Record<string, string>) {
    const res = await fetch(gh.webUrl + path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json().catch(() => ({})) as Record<string, string>;
    if (!res.ok && !j.error) throw new HttpError(502, `GitHub ${path}: ${res.status}`, "github_error");
    return j;
  }

  async function ghApi<T>(path: string, accessToken: string): Promise<{ ok: boolean; body: T }> {
    const res = await fetch(gh.apiUrl + path, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "cresslet",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, body: await res.json().catch(() => null) as T };
  }

  /** Map a GitHub access token to a Cresslet account (find, link by verified email, or create) + new token. */
  async function login(accessToken: string, tokenName: string): Promise<Login> {
    const u = await ghApi<GithubUser>("/user", accessToken);
    if (!u.ok || !u.body?.id) throw new HttpError(502, "could not read GitHub user", "github_error");
    const user = u.body;
    const ident = { id: user.id, login: user.login };

    let account = await store.accountByGithub(user.id);
    if (account) {
      if (account.github_login !== user.login) {
        await store.linkGithub(account.id, ident);
        account = { ...account, github_login: user.login };
      }
    } else {
      const e = await ghApi<{ email: string; primary: boolean; verified: boolean }[]>("/user/emails", accessToken);
      // Primary first. Public profile emails are verified by GitHub; /user/emails can 403 for some token types.
      const verified = (e.ok && Array.isArray(e.body) ? e.body.filter((x) => x.verified) : [])
        .sort((x, y) => Number(y.primary) - Number(x.primary)).map((x) => x.email.toLowerCase());
      if (!verified.length && user.email) verified.push(user.email.toLowerCase());
      if (await store.disabledAccount({ githubId: user.id, emails: verified })) {
        throw new HttpError(403, "this account is disabled; ask a site admin", "account_disabled");
      }
      // An account set up for one of the verified emails (invited by a site admin, or operator-created) that
      // isn't linked to GitHub yet: primary email first.
      let existing: Account | undefined, linkable: Account | undefined;
      for (const email of verified) {
        const a = await store.accountByEmail(email);
        existing ??= a;
        if (a && !a.github_id) {
          linkable = a;
          break;
        }
      }
      const email = verified[0] ?? `${user.id}+${user.login}@users.noreply.github.com`;
      if (linkable) {
        // Tokens and a password set before this link (operator-created accounts) weren't proven to belong to this person.
        const linked = await store.linkGithubFirst(linkable.id, ident);
        // Linked to another GitHub account meanwhile: not this person's.
        if (linked?.github_id !== ident.id) throw new HttpError(409, "this account changed meanwhile: log in again", "conflict");
        account = linked;
      } else {
        if (!cfg.openSignup) throw new HttpError(403, "signup is closed; ask a site admin for an invite", "forbidden");
        // Email already taken by another GitHub-linked account: fall back to the GitHub noreply address.
        account = await store.createAccount(existing ? `${user.id}+${user.login}@users.noreply.github.com` : email, ident);
      }
    }
    if (account.disabled_at) throw new HttpError(403, "this account is disabled; ask a site admin", "account_disabled");
    try {
      return { account, token: (await store.issueToken(account.id, { name: tokenName })).token };
    } catch (e) {
      if (e instanceof AccountDisabledError) throw new HttpError(403, "this account is disabled; ask a site admin", "account_disabled");
      throw e;
    }
  }

  return {
    callbackUrl: (root: string) => `${root}/v1/auth/github/callback`,

    /** Start the web flow: returns the state (bind it to the browser) and the authorize URL. */
    authorize(redirectUri: string) {
      sweep(states, (v) => v);
      const state = id("st", 16);
      states.set(state, Date.now() + STATE_TTL);
      const q = new URLSearchParams({ client_id: gh.clientId, redirect_uri: redirectUri, scope: SCOPE, state });
      return { state, url: `${gh.webUrl}/login/oauth/authorize?${q}` };
    },

    /** Finish the web flow; returns a one-time code the studio exchanges for the token. */
    async callback(code: string, state: string, redirectUri: string): Promise<string> {
      const exp = states.get(state);
      states.delete(state);
      if (!exp || exp < Date.now()) throw new HttpError(400, "login expired, try again", "bad_request");
      const t = await oauth("/login/oauth/access_token", {
        client_id: gh.clientId,
        client_secret: gh.clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      if (!t.access_token) throw new HttpError(400, t.error_description ?? t.error ?? "GitHub login failed", "github_error");
      const l = await login(t.access_token, "Studio (GitHub login)");
      sweep(codes, (v) => v.exp);
      const once = id("lc", 16);
      codes.set(once, { ...l, exp: Date.now() + CODE_TTL });
      return once;
    },

    exchange(code: string): Login {
      const c = codes.get(code);
      codes.delete(code);
      if (!c || c.exp < Date.now()) throw new HttpError(400, "invalid or expired login code", "bad_request");
      return c;
    },

    async deviceStart() {
      const d = await oauth("/login/device/code", { client_id: gh.clientId, scope: SCOPE });
      if (!d.device_code) {
        const msg = d.error === "device_flow_disabled"
          ? "GitHub device flow is disabled for this OAuth app (operator: enable it in the app settings)"
          : d.error_description ?? d.error ?? "GitHub device flow failed";
        throw new HttpError(502, msg, "github_error");
      }
      return {
        deviceCode: d.device_code,
        userCode: d.user_code,
        verificationUri: d.verification_uri,
        expiresIn: Number(d.expires_in),
        interval: Number(d.interval),
      };
    },

    async devicePoll(deviceCode: string): Promise<{ status: "pending" | "slow_down"; interval?: number } | Login> {
      const t = await oauth("/login/oauth/access_token", {
        client_id: gh.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (t.access_token) return login(t.access_token, "CLI (GitHub device login)");
      if (t.error === "authorization_pending") return { status: "pending" };
      if (t.error === "slow_down") return { status: "slow_down", interval: Number(t.interval) || undefined };
      const msg = t.error === "expired_token" ? "code expired, run login again"
        : t.error === "access_denied" ? "login cancelled on GitHub"
        : t.error_description ?? t.error ?? "GitHub login failed";
      throw new HttpError(400, msg, t.error ?? "github_error");
    },
  };
}
