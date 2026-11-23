// The page around every view: skip link, sidebar (not on the landing page or in a project), the view, the toast.
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { projects, type StoredProject } from "../../store.ts";
import { meta, mustLogIn } from "../lib/api.ts";
import { focusView, navigated } from "../lib/focus.ts";
import { ViewContext, type ViewInfo } from "../lib/hooks.ts";
import { onProjectsChanged } from "../lib/projects.ts";
import { finishLogin, logIn, refreshAccount, useLoginButton, useMovingSession, useSession } from "../lib/session.ts";
import { Toast } from "../lib/toast.tsx";
import { Icon, Sprite, SrOnly } from "./icons.tsx";

const NavLink = ({ to, nav, current, icon, children }: { to: string; nav: string; current?: string; icon: string; children: string }) => (
  <li>
    <Link to={to} data-nav={nav} aria-current={current === nav ? "page" : undefined}><Icon name={icon} />{children}</Link>
  </li>
);
const ExtNav = ({ href, icon, children }: { href: string; icon: string; children: string }) => (
  <li>
    <a href={href} target="_blank" rel="noopener"><Icon name={icon} />{children}<SrOnly> (opens in a new tab)</SrOnly><Icon name="external" className="icon trail" /></a>
  </li>
);

export function Layout() {
  const [view, setViewState] = useState<ViewInfo>({ view: "" });
  const setView = useCallback((v: ViewInfo) => setViewState((o) => (o.view === v.view && o.nav === v.nav ? o : v)), []);
  const s = useSession();
  const moving = useMovingSession();
  const login = useLoginButton();
  const navigate = useNavigate();
  const [credits, setCredits] = useState(false);
  const [recent, setRecent] = useState<StoredProject[]>([]);
  const href = useRouterState({ select: (r) => r.resolvedLocation?.href });

  useEffect(() => {
    void meta().then((m) => setCredits(!!m.ai?.credits));
    // Opened by the GitHub login callback: finish it, then back to what needed the login.
    void finishLogin().then((to) => {
      if (to) void navigate({ href: to });
    });
  }, [navigate]);

  // Role can change server-side, and the token can change under the page (another tab): load its account.
  useEffect(() => {
    if (s.user && !s.accountId) void refreshAccount();
  }, [s.user, s.accountId]);

  // Recent projects (not when projects need a login this browser doesn't have).
  const inProject = view.view === "workspace";
  useEffect(() => {
    if (inProject) return;
    let live = true;
    const load = async () => {
      const list = await mustLogIn() ? [] : (await projects.list().catch(() => [])).slice(0, 6);
      if (live) setRecent(list);
    };
    void load();
    const off = onProjectsChanged(load);
    return () => {
      live = false;
      off();
    };
  }, [inProject, s.user, href]);

  // In-app navigation: the new view's heading gets focus (the first page load keeps the browser's own).
  const first = useRef(true);
  useEffect(() => {
    if (href === undefined) return;
    if (first.current) {
      first.current = false;
      return;
    }
    scrollTo(0, 0);
    navigated();
  }, [href]);

  const nav = view.nav;
  return (
    <>
      <Sprite />
      <a className="skip-link" id="skip-link" href="#content" onClick={(e) => {
        e.preventDefault(); // focus the view, not just scroll to it
        focusView({ scroll: true });
      }}>Skip to content</a>
      <div className="app" id="app" data-view={view.view || undefined}>
        <aside className="sidebar" aria-label="Studio">
          <Link className="brand" to="/">
            <Icon name="logo" className="brand-mark" />
            <span>Cresslet</span>
            <span className="brand-tag">Studio</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <p className="nav-label" id="nav-workspace">Workspace</p>
            <ul aria-labelledby="nav-workspace">
              <NavLink to="/" nav="home" current={nav} icon="folder">Projects</NavLink>
              <NavLink to="/artifacts" nav="pages" current={nav} icon="file">Artifacts</NavLink>
              {s.orgs.length ? <NavLink to="/orgs" nav="orgs" current={nav} icon="users">Organizations</NavLink> : null}
              {s.user ? <NavLink to="/settings" nav="settings" current={nav} icon="settings">Settings</NavLink> : null}
            </ul>
            {recent.length ? (
              <div id="recent-wrap">
                <p className="nav-label" id="nav-recent">Recent projects</p>
                <ul id="recent" className="recent" aria-labelledby="nav-recent">
                  {recent.map((p) => (
                    <li key={p.id}><Link to="/p/$id" params={{ id: p.id }}><Icon name="code" /><span>{p.name}</span></Link></li>
                  ))}
                </ul>
              </div>
            ) : null}
            {s.siteAdmin ? (
              <div id="admin-item">
                <p className="nav-label" id="nav-admin">Site Administrator</p>
                <ul aria-labelledby="nav-admin">
                  <NavLink to="/admin" nav="admin" current={nav} icon="server">Sites</NavLink>
                  <NavLink to="/admin-users" nav="admin-users" current={nav} icon="users">Users</NavLink>
                  <NavLink to="/admin-orgs" nav="admin-orgs" current={nav} icon="shield">Organizations</NavLink>
                  {credits ? <NavLink to="/admin-credits" nav="admin-credits" current={nav} icon="sparkles">AI credits</NavLink> : null}
                </ul>
              </div>
            ) : null}
            <p className="nav-label" id="nav-resources">Resources</p>
            <ul aria-labelledby="nav-resources">
              <ExtNav href="https://github.com/ODumpling/cresslet#docs" icon="book">Docs</ExtNav>
              <ExtNav href="https://github.com/ODumpling/cresslet-cli" icon="terminal">CLI</ExtNav>
            </ul>
          </nav>
          <div className="sidebar-foot">
            <button className="account" id="account-btn" type="button" onClick={() => (s.user ? navigate({ to: "/settings" }) : void logIn())}>
              <Icon name={s.user ? "github" : login.icon} />
              <span id="account-label">{s.user ? <>{s.email ?? "Account"}<SrOnly>: account settings</SrOnly></> : login.label}</span>
            </button>
          </div>
        </aside>
        <div className="content" id="content" tabIndex={-1}>
          <ViewContext value={setView}>
            {moving ? null : <Outlet />}
          </ViewContext>
        </div>
      </div>
      <Toast />
    </>
  );
}
