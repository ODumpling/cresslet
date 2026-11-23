// /login: email + password, and GitHub when the server has it too (session.ts logIn sends people here). Logged in
// already: back to where the login was for.
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../api-types.ts";
import { api, errorMessage, json, meta } from "../lib/api.ts";
import { useAlive, useView } from "../lib/hooks.ts";
import { afterLoginPath, setAccount, useSession } from "../lib/session.ts";
import { toast } from "../lib/toast.tsx";
import { FormError } from "../ui/bits.tsx";
import { Icon } from "../ui/icons.tsx";

export function Login() {
  useView("login", "Log in");
  const navigate = useNavigate();
  const { token } = useSession();
  const alive = useAlive();
  const [m, setMeta] = useState<API.Meta | null>(null);
  useEffect(() => void meta().then(setMeta), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (token && !busy) void navigate({ href: afterLoginPath() ?? "/", replace: true });
  }, [token, busy, navigate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ token: string; account: API.Account }>("/v1/auth/password", json("POST", { email, password }));
      if (!alive.current) return;
      setAccount(r);
      const to = afterLoginPath();
      if (!to) toast(`Logged in as ${r.account.github ?? r.account.email}`);
      void navigate({ href: to ?? "/", replace: true });
    } catch (err) {
      if (!alive.current) return;
      flushSync(() => {
        setError(errorMessage(err));
        setBusy(false);
      });
      passwordInput.current?.select();
    }
  }

  const off = m && !m.auth?.password;
  return (
    <main id="login" className="page narrow" aria-labelledby="login-title">
      <header className="page-head">
        <div>
          <h1 id="login-title" tabIndex={-1}>Log in</h1>
          <p className="muted" id="login-text">{off ? "Email and password login isn't on for this server." : "Log in with your email and password."}</p>
        </div>
      </header>
      <form id="login-form" className="panel form" hidden={!!off} onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input className="input" id="login-email" type="email" required autoComplete="username" spellCheck={false} aria-describedby="login-error"
            value={email} onChange={(e) => (setEmail(e.target.value), setError(""))} />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input className="input" id="login-password" type="password" required ref={passwordInput} autoComplete="current-password" aria-describedby="login-error"
            value={password} onChange={(e) => (setPassword(e.target.value), setError(""))} />
        </div>
        <FormError id="login-error" text={error} />
        <div className="row start"><button className="btn primary" id="login-submit" type="submit" disabled={busy}>Log in</button></div>
        <p className="muted small">No password yet? Log in another way, then set one in Settings. Forgot it? Ask this server's operator.</p>
      </form>
      {m?.auth?.github ? (
        <div className="row start" id="login-github">
          <a className="btn" href="/v1/auth/github"><Icon name="github" />Log in with GitHub</a>
        </div>
      ) : null}
    </main>
  );
}
