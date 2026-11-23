// /cli: where `cresslet auth login` sends the browser. The user types the code from their terminal (it isn't in the
// link, so a link someone else sent can't log their CLI in to this account), and the CLI's poll then gets a new token
// for this account.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { auth } from "../../store.ts";
import type * as API from "../../api-types.ts";
import { api, errorMessage, json } from "../lib/api.ts";
import { focusView } from "../lib/focus.ts";
import { useAlive, useLoad, useView } from "../lib/hooks.ts";
import { logIn, useLoginButton, useSession } from "../lib/session.ts";
import { FormError } from "../ui/bits.tsx";
import { Icon } from "../ui/icons.tsx";

export function CliLogin() {
  useView("cli-login", "Log in the CLI");
  const { token } = useSession();
  const login = useLoginButton();
  const alive = useAlive();
  // Name the account this session's token belongs to, and approve only with that same token. The session changed
  // meanwhile (another tab): this starts over with the current one.
  const acct = useLoad(() => (token
    ? api<{ account: API.Account }>("/v1/me").then((r) => ({ token, account: r.account, error: "" }), (e) => ({ token, account: null, error: errorMessage(e) }))
    : Promise.resolve(null)), [token]);
  const mine = acct.data?.token === token ? acct.data : null; // not the previous session's, while it reloads
  const account = mine?.account ?? null;
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [doneFor, setDoneFor] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setCode("");
    setError("");
  }, [token]);
  const done = !!token && doneFor === token;

  async function approve(e: FormEvent) {
    e.preventDefault();
    if (!token || auth.token !== token) return; // another tab changed the session: the view follows it
    setBusy(true);
    try {
      await api("/v1/auth/cli/approve", json("POST", { userCode: code }));
      if (!alive.current) return;
      flushSync(() => setDoneFor(token));
      focusView();
    } catch (err) {
      if (!alive.current || !auth.token) return; // session expired: the view offers the login
      flushSync(() => setError(`Could not authorize: ${errorMessage(err)}`));
      codeInput.current?.focus();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const text = !token ? "Log in to let the Cresslet CLI use your account."
    : done ? "CLI logged in. You can close this tab and go back to your terminal."
    : mine?.error ? `Could not load your account: ${mine.error}`
    : account ? `Enter the code that cresslet auth login shows in your terminal. The CLI gets full access to ${account.github ?? account.email}. Only enter a code from a terminal you're using.`
    : "Checking your account…";

  return (
    <main id="cli-login" className="page narrow" aria-labelledby="cli-login-title">
      <header className="page-head">
        <div>
          <h1 id="cli-login-title" tabIndex={-1}>Log in the CLI</h1>
          <p className="muted" id="cli-login-text" aria-live="polite">{text}</p>
        </div>
      </header>
      <form id="cli-login-form" className="panel form" hidden={!account || done} onSubmit={(e) => void approve(e)}>
        <div className="field">
          <label htmlFor="cli-login-code">Code from your terminal</label>
          <input className="input mono" id="cli-login-code" ref={codeInput} required placeholder="XXXX-XXXX" maxLength={16} autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby="cli-login-error"
            value={code} onChange={(e) => {
              setCode(e.target.value);
              setError("");
            }} />
        </div>
        <FormError id="cli-login-error" text={error} />
        <div className="row start"><button className="btn primary" id="cli-login-approve" type="submit" disabled={busy}>Authorize CLI</button></div>
      </form>
      <div className="row start" id="cli-login-actions">
        {token ? null : <button className="btn primary" type="button" onClick={() => void logIn("/cli")}><Icon name={login.icon} />{login.label}</button>}
      </div>
    </main>
  );
}
