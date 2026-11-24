// /view/<page>?path=…: where a private artifact sends a visitor without a session. Asks the server for a one-time
// sign-in link to the page (owner and collaborators only) and goes there. /view/<app>--<env>: the same for an app's
// private environment (staging), for anyone with access to the app.
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, errorMessage, json, statusOf } from "../lib/api.ts";
import { useView } from "../lib/hooks.ts";
import { logIn, session, useLoginButton, useSession } from "../lib/session.ts";
import { Icon } from "../ui/icons.tsx";

type State = { text: string; action: "retry" | "home" | null };

export function PrivateView() {
  const { name } = useParams({ from: "/view/$name" });
  useView("view", name.includes("--") ? `Private ${name.slice(name.indexOf("--") + 2)}` : "Private artifact");
  const { path } = useSearch({ from: "/view/$name" });
  const { user } = useSession();
  const login = useLoginButton();
  const [state, setState] = useState<State>({ text: "Opening…", action: null });
  const [attempt, setAttempt] = useState(0); // Try again
  const key = `cresslet.view.${name}`;
  // `<app>--<env>` (page and app names never hold `--`): one of an app's environments.
  const cut = name.indexOf("--");
  const envOf = cut > 0 ? { app: name.slice(0, cut), env: name.slice(cut + 2) } : null;
  const what = envOf ? `${envOf.app}'s ${envOf.env}` : "this artifact";

  useEffect(() => {
    if (!user) return;
    let live = true;
    // A browser that drops the page's cookie would bounce between here and the page forever.
    let tries: number[] = [];
    try {
      tries = (JSON.parse(sessionStorage.getItem(key) ?? "[]") as number[]).filter((t) => Date.now() - t < 60_000); // what this page stored
      sessionStorage.setItem(key, JSON.stringify([...tries, Date.now()]));
    } catch { /* storage blocked */ }
    if (tries.length >= 3) {
      setState({ text: `Your browser didn't keep ${what}'s sign-in. Allow cookies for it, then try again.`, action: "retry" });
      return;
    }
    setState({ text: "Opening…", action: null });
    const at = envOf ? `/v1/apps/${encodeURIComponent(envOf.app)}/envs/${encodeURIComponent(envOf.env)}/view` : `/v1/pages/${encodeURIComponent(name)}/view`;
    api<{ url: string }>(at, json("POST", { path })).then(({ url }) => {
      if (live) location.replace(url);
    }, (e) => {
      if (!live) return;
      const status = statusOf(e);
      setState({
        text: status === 404 ? (envOf ? `${what} doesn't exist.` : "This artifact doesn't exist, or it expired.")
          : status === 403 ? `You don't have access to ${what} (logged in as ${session().email}). Ask its owner to share it with you.`
          : `Could not open ${what}: ${errorMessage(e)}`,
        action: "home",
      });
    });
    return () => void (live = false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- envOf and what follow name
  }, [user, name, path, key, attempt]);

  const text = user ? state.text : `${envOf ? `${what[0]!.toUpperCase()}${what.slice(1)} is` : "This artifact is"} private. Log in to open it, if its owner shared it with you.`;
  return (
    <main id="view" className="page narrow" aria-labelledby="view-title">
      <header className="page-head">
        <div>
          <h1 id="view-title" tabIndex={-1}>{envOf ? `Private ${envOf.env}` : "Private artifact"}</h1>
          <p className="muted" id="view-text" aria-live="polite">{text}</p>
        </div>
      </header>
      <div className="row start" id="view-actions">
        {!user ? <button className="btn primary" type="button" onClick={() => void logIn(location.pathname + location.search)}><Icon name={login.icon} />{login.label}</button>
          : state.action === "retry" ? (
            <button className="btn" type="button" onClick={() => {
              try {
                sessionStorage.removeItem(key);
              } catch { /* storage blocked */ }
              setAttempt((n) => n + 1);
            }}><Icon name="refresh" />Try again</button>
          )
          : state.action === "home" ? <Link className="btn" to="/">Go to Projects</Link>
          : null}
      </div>
    </main>
  );
}
