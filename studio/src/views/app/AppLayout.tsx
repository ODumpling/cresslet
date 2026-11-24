// /apps/<name>[/database[/<table>]|/secrets|/crons|/logs|/settings]: one deployed app's dashboard (anyone with access; viewers read
// only): the header, its actions and tabs. The app's detail loads here and the tabs read it (useApp); Refresh
// reloads it and the open tab's own data.
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type * as API from "../../../api-types.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { refocus } from "../../lib/focus.ts";
import { ACCESS_LABEL, ago, canManage } from "../../lib/format.ts";
import { useLoad, useView } from "../../lib/hooks.ts";
import { openDeployed } from "../../lib/projects.ts";
import { useSession } from "../../lib/session.ts";
import { ExtLink, Icon, SrOnly } from "../../ui/icons.tsx";

export const appPath = (name: string, rest = "") => `/v1/apps/${encodeURIComponent(name)}${rest}`;
/** As appPath, of one of the app's environments (`?env=`; production: none). */
export const envPath = (name: string, env: string, rest = "") => {
  const p = appPath(name, rest);
  return env === "production" ? p : `${p}${p.includes("?") ? "&" : "?"}env=${encodeURIComponent(env)}`;
};

interface AppCtx {
  name: string;
  /** The environment the dashboard shows ("production", "staging"): its deploys, logs, database, secrets, crons. */
  env: string;
  d: API.AppDetail;
  /** Reloads the detail and the open tab's data; resolves true once both are in the page. */
  refresh: () => Promise<boolean>;
  /** A tab's own loader, for Refresh (returns the unregister). */
  register: (reload: () => Promise<boolean>) => () => void;
}
const AppContext = createContext<AppCtx | null>(null);
/** The app the tab shows (only rendered inside AppLayout, once the detail loaded). */
export function useApp(): AppCtx {
  const c = useContext(AppContext);
  if (!c) throw new Error("useApp outside AppLayout");
  return c;
}
/** Refresh reloads this tab's data too. */
export function useTabReload(reload: () => Promise<boolean>) {
  const { register } = useApp();
  useEffect(() => register(reload), [register, reload]);
}

/** A tab's data couldn't load: what went wrong, and Retry (the whole page, as Refresh). */
export function TabError({ error }: { error: Error }) {
  const { refresh } = useApp();
  return (
    <>
      <p className="error">Could not load: {error.message}</p>
      <div className="row start">
        <button className="btn" type="button" onClick={() => void refresh()}><Icon name="refresh" />Retry</button>
      </div>
    </>
  );
}

const TABS = [
  ["", "Overview", "server"],
  ["database", "Database", "database"],
  ["secrets", "Secrets", "key"],
  ["crons", "Crons", "clock"],
  ["logs", "Logs", "terminal"],
  ["settings", "Settings", "settings"],
] as const;

export function AppLayout() {
  const { name } = useParams({ from: "/apps/$name" });
  const { user } = useSession();
  const navigate = useNavigate();
  useView("site", name);
  useEffect(() => {
    if (!user) void navigate({ to: "/", replace: true });
  }, [user, navigate]);
  // Another app or account: a fresh page (nothing of the previous one stays shown, its streams stop).
  return user ? <AppPage key={`${user}\n${name}`} name={name} /> : null;
}

/** The environment the dashboard showed last for this app, in this tab. */
const envKey = (name: string) => `cresslet.app-env.${name}`;
function savedEnv(name: string) {
  try {
    return sessionStorage.getItem(envKey(name)) ?? "production";
  } catch {
    return "production";
  }
}

function AppPage({ name }: { name: string }) {
  const navigate = useNavigate();
  const [env, setEnvState] = useState(() => savedEnv(name));
  const setEnv = useCallback((e: string) => {
    setEnvState(e);
    try {
      sessionStorage.setItem(envKey(name), e);
    } catch { /* storage blocked */ }
  }, [name]);
  const detail = useLoad(() => api<API.AppDetail>(envPath(name, env)), [name, env]);
  // An environment that's gone (deleted elsewhere): back to production.
  useEffect(() => {
    if (env !== "production" && detail.error?.status === 404) setEnv("production");
  }, [env, detail.error, setEnv]);
  const tabReload = useRef<(() => Promise<boolean>) | null>(null);
  const register = useCallback((fn: () => Promise<boolean>) => {
    tabReload.current = fn;
    return () => {
      if (tabReload.current === fn) tabReload.current = null;
    };
  }, []);
  const reloadDetail = detail.reload;
  const refresh = useCallback(async () => {
    const [a, b] = await Promise.all([reloadDetail(), tabReload.current?.() ?? true]);
    return a && b;
  }, [reloadDetail]);
  const again = () => void refresh().then((ok) => ok && refocus(document.querySelector<HTMLElement>("#site-actions button")));

  const d = detail.data;
  // (The detail of the environment asked for: while another loads, the one shown stays until it's in.)
  const shown = d && (d.env ?? "production") === env ? d : null;
  const ctx = useMemo(() => (shown ? { name, env, d: shown, refresh, register } : null), [name, env, shown, refresh, register]);
  const a = d?.app;
  const sub = a
    ? [ACCESS_LABEL[a.access] ? `You're ${a.access === "owner" ? (a.org ? "an owner" : "the owner") : `${a.access === "admin" ? "an" : "a"} ${a.access}`}` : null,
      a.org ? `In ${a.org.title ?? a.org.name}` : null,
      a.config?.server ? "Server app" : "Static site", a.claimed ? null : `Unclaimed${a.expiresAt ? `, expires ${ago(a.expiresAt)}` : ""}`].filter(Boolean).join(" · ")
    : "";
  const err = detail.error;
  const hidden = err && (err.status === 404 || err.status === 403);

  // A failed load: Retry takes the actions' place, and focus if the control that had it went.
  useEffect(() => {
    if (err && !hidden) refocus(document.querySelector<HTMLElement>("#site-actions button"));
  }, [err, hidden]);

  async function openSource(app: { name: string; url: string }) {
    try {
      void navigate({ to: "/p/$id", params: { id: await openDeployed(app) } });
    } catch (e) {
      alert(`Could not open ${app.name}: ${errorMessage(e)}`);
    }
  }

  return (
    <main id="site" className="page wide" aria-labelledby="site-title">
      <header className="page-head">
        <div>
          <h1 id="site-title" tabIndex={-1}><Link to="/">Projects</Link>{" / "}{name}</h1>
          <p className="muted" id="site-sub">{sub}</p>
        </div>
        <div className="row start" id="site-actions">
          {a ? (
            <>
              <ExtLink href={a.url} className="btn">Visit</ExtLink>
              <button className="btn" type="button" title="Open the app as a new project in the studio: its repository's default branch when it's linked, else its deployed source" onClick={() => void openSource(a)}><Icon name="code" />Open in studio</button>
              {canManage(a.access) ? <Link className="btn" to="/share/$name" params={{ name }}><Icon name="users" />Share</Link> : null}
              <button className="btn" type="button" title="Refresh" onClick={again}><Icon name="refresh" /><SrOnly>Refresh</SrOnly></button>
            </>
          ) : err && !hidden ? (
            <button className="btn" type="button" onClick={again}><Icon name="refresh" />Retry</button>
          ) : null}
        </div>
      </header>
      {d?.environments && d.environments.length > 1 ? <EnvSwitch envs={d.environments} env={env} setEnv={setEnv} /> : null}
      <Tabs name={name} />
      <section id="site-body" aria-labelledby="site-title">
        {ctx ? <AppContext value={ctx}><Outlet key={env} /></AppContext>
          : err ? <p className="error">{hidden ? `There's no app named ${name} that you can see.` : `Could not load: ${err.message}`}</p>
          : <p className="muted">Loading…</p>}
      </section>
    </main>
  );
}

/** Production | staging: which environment the dashboard (every tab) shows. */
function EnvSwitch({ envs, env, setEnv }: { envs: API.Environment[]; env: string; setEnv: (e: string) => void }) {
  const cur = envs.find((e) => e.name === env);
  return (
    <div className="row start env-switch" id="env-switch" role="group" aria-label="Environment">
      {envs.map((e) => (
        <button key={e.name} type="button" className={`btn sm${e.name === env ? " primary" : ""}`} aria-pressed={e.name === env}
          id={`env-${e.name}`} onClick={() => setEnv(e.name)}>
          {e.name === "production" ? "Production" : e.name[0]!.toUpperCase() + e.name.slice(1)}
        </button>
      ))}
      {cur && cur.name !== "production" ? (
        <span className="muted small"><ExtLink href={cur.url}>{cur.url.replace(/^https?:\/\//, "")}</ExtLink>{" · private: you, its collaborators and organization"}</span>
      ) : null}
    </div>
  );
}

/** The tabs: deep links, the open one marked current (Overview only on its own page, Database on any table). */
function Tabs({ name }: { name: string }) {
  return (
    <nav className="site-tabs" id="site-tabs" aria-label="App sections">
      {TABS.map(([k, label, ico]) => {
        const inner = <><Icon name={ico} />{label}</>;
        const p = { className: "site-tab", activeProps: {} } as const;
        return k === "" ? <Link key={k} {...p} to="/apps/$name" params={{ name }} activeOptions={{ exact: true }}>{inner}</Link>
          : k === "database" ? <Link key={k} {...p} to="/apps/$name/database/{-$table}" params={{ name, table: undefined }}>{inner}</Link>
          : <Link key={k} {...p} to={`/apps/$name/${k}`} params={{ name }} activeOptions={{ exact: true }}>{inner}</Link>;
      })}
    </nav>
  );
}
