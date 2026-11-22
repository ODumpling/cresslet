// / with a session (or local projects on a server without login): templates, local projects, invitations and the
// deployed apps you can see.
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { projects, type StoredProject } from "../../store.ts";
import type * as API from "../../api-types.ts";
import { api, errorMessage } from "../lib/api.ts";
import { refocus, refocusId, viewShown } from "../lib/focus.ts";
import { ACCESS_LABEL, bareUrl } from "../lib/format.ts";
import { useLoad, useView } from "../lib/hooks.ts";
import { onProjectsChanged, openDeployed, projectsChanged } from "../lib/projects.ts";
import { session, useSession } from "../lib/session.ts";
import { toast } from "../lib/toast.tsx";
import { DataTable, EmptyState, TimeAgo } from "../ui/bits.tsx";
import { ExtLink, Icon, SrOnly } from "../ui/icons.tsx";
import { copyCommand, TEMPLATE_ICONS, Templates } from "../ui/templates.tsx";

export function Home() {
  useView("home", "");
  useLayoutEffect(viewShown, []);
  const { token } = useSession();
  const cliCmd = useRef<HTMLElement>(null);
  return (
    <main id="home" className="page" aria-labelledby="home-title">
      <header className="page-head">
        <div>
          <h1 id="home-title" tabIndex={-1}>Projects</h1>
          <p className="muted">Start something new, or pick up where you left off.</p>
        </div>
      </header>
      <section className="block first" aria-labelledby="templates-title">
        <div className="block-head">
          <h2 id="templates-title">New project</h2>
          <p className="muted small">Pick a template</p>
        </div>
        <Templates id="templates" />
      </section>
      <section className="block" aria-labelledby="projects-title">
        <div className="block-head">
          <h2 id="projects-title">Your projects</h2>
          <p className="muted small">Stored in this browser</p>
        </div>
        <Projects />
      </section>
      {token ? <Shared key={token} /> : null}
      <section className="block" aria-labelledby="cli-label">
        <div className="panel split cli-panel">
          <div>
            <h2 id="cli-label">Prefer your terminal or an agent?</h2>
            <p className="muted small">Scaffold, run and deploy with the CLI. Every command takes <code>--json</code>.</p>
          </div>
          <div className="cli-box">
            <code id="cli-cmd" ref={cliCmd}><span className="cli-prompt" aria-hidden="true">$ </span>npx cresslet new my-app</code>
            <button className="icon-btn" id="cli-copy" type="button" aria-describedby="cli-label" onClick={() => void copyCommand("npx cresslet new my-app", cliCmd.current)}>
              <Icon name="copy" /><SrOnly>Copy command</SrOnly>
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

/** Local projects (after a delete, the rest of the home view stays as it is, focus included). */
function Projects() {
  const [list, setList] = useState<StoredProject[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => projects.list().catch(() => []).then((l) => live && setList(l));
    void load();
    const off = onProjectsChanged(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  async function remove(p: StoredProject) {
    if (!confirm(`Delete local project ${p.name}? Deployed apps are not affected.`)) return;
    await projects.delete(p.id);
    toast(`Deleted ${p.name}`);
    const next = await projects.list().catch(() => []);
    flushSync(() => setList(next));
    projectsChanged();
    refocus();
  }
  if (!list) return <div id="projects" />;
  return (
    <div id="projects">
      {list.length ? (
        <DataTable label="Your projects table" labelledBy="projects-title" heads={[["Project"], ["Template"], ["Deployed to"], ["Edited"], ["Actions", "actions", true]]}>
          {list.map((p) => (
            <tr className="list-row" key={p.id}>
              <td><div className="name-cell">
                <span className="file-ico"><Icon name={TEMPLATE_ICONS[p.template] ?? "code"} /></span>
                <Link to="/p/$id" params={{ id: p.id }}>{p.name}</Link>
              </div></td>
              <td className="muted">{p.template}</td>
              <td>{p.deploy?.url ? <ExtLink href={p.deploy.url}>{bareUrl(p.deploy.url)}</ExtLink> : <span className="muted">Not deployed</span>}</td>
              <td className="muted"><TimeAgo iso={p.updatedAt} /></td>
              <td className="actions">
                <button className="icon-btn danger" type="button" title="Delete project" id={`delete-${p.id}`} aria-label={`Delete ${p.name}`} onClick={() => void remove(p)}>
                  <Icon name="trash" />
                </button>
              </td>
            </tr>
          ))}
        </DataTable>
      ) : <EmptyState title="No projects yet">Pick a template above. Projects are saved in this browser as you edit.</EmptyState>}
    </div>
  );
}

/** Invitations, and the deployed apps you can see (logged in). */
function Shared() {
  const navigate = useNavigate();
  const invites = useLoad(() => api<{ invites: API.MyInvite[] }>("/v1/me/invites").then((r) => r.invites, (): API.MyInvite[] => []), []);
  const apps = useLoad(() => api<{ apps: API.AppSummary[] }>("/v1/apps").then((r) => r.apps), []);

  async function answer(i: API.MyInvite, accept: boolean) {
    let r: { app: { access: string } };
    try {
      r = await api<{ app: { access: string } }>(`/v1/me/invites/${encodeURIComponent(i.id)}${accept ? "/accept" : ""}`, accept ? { method: "POST", body: "{}" } : { method: "DELETE" });
    } catch (e) {
      // e.g. 404: cancelled, or re-sent with another role (a new invite): show the current ones.
      toast(`Could not ${accept ? "accept" : "decline"} the invite: ${errorMessage(e)}`);
      await invites.reload();
      refocusId(document.getElementById("invites-title") ? "invites-title" : "apps-title");
      return;
    }
    // An invite can be to an app (Deployed apps) or an artifact (Artifacts).
    toast(accept ? `Joined ${i.app} as ${ACCESS_LABEL[r.app.access]?.toLowerCase() ?? r.app.access}: it's in Deployed apps or Artifacts` : `Declined the invite to ${i.app}`);
    await Promise.all([invites.reload(), accept ? apps.reload() : null]);
    refocusId(document.getElementById("invites-title") ? "invites-title" : "apps-title");
  }

  async function leave(a: API.AppSummary) {
    if (!confirm(`Leave ${a.name}? You lose access to it until someone invites you again.`)) return;
    try {
      const id = session().accountId ?? (await api<{ account: API.Account }>("/v1/me")).account.id;
      await api(`/v1/apps/${encodeURIComponent(a.name)}/collaborators/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      toast(`Could not leave ${a.name}: ${errorMessage(e)}`);
      return;
    }
    toast(`You left ${a.name}`);
    await apps.reload();
    refocusId("apps-title");
  }

  async function openSource(a: API.AppSummary) {
    try {
      navigate({ to: "/p/$id", params: { id: await openDeployed(a) } });
    } catch (e) {
      alert(`Could not open ${a.name}: ${errorMessage(e)}`);
    }
  }

  return (
    <>
      {invites.data?.length ? (
        <section className="block" id="invites-section" aria-labelledby="invites-title">
          <div className="block-head">
            <h2 id="invites-title" tabIndex={-1}>Invitations</h2>
            <p className="muted small">Apps and artifacts other people shared with you</p>
          </div>
          <ul className="list" id="invites" aria-labelledby="invites-title">
            {invites.data.map((i) => (
              <li className="list-row" key={i.id}>
                <div className="tok">
                  <strong>{i.app}</strong>
                  <span className="meta">{`${ACCESS_LABEL[i.role]}${i.invitedBy ? ` · invited by ${i.invitedBy.github ?? i.invitedBy.email}` : ""}`}</span>
                </div>
                <button className="btn sm primary" type="button" id={`accept-${i.id}`} aria-label={`Accept invite to ${i.app}`} onClick={() => void answer(i, true)}>Accept</button>
                <button className="btn sm" type="button" id={`decline-${i.id}`} aria-label={`Decline invite to ${i.app}`} onClick={() => void answer(i, false)}>Decline</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="block" id="apps-section" aria-labelledby="apps-title">
        <div className="block-head">
          <h2 id="apps-title" tabIndex={-1}>Deployed apps</h2>
          <p className="muted small">Yours and the ones shared with you</p>
        </div>
        <div id="apps">
          {apps.error ? <p className="error">Could not load apps: {apps.error.message}</p>
            : !apps.data ? null
            : apps.data.length ? (
              <DataTable label="Deployed apps table" labelledBy="apps-title" heads={[["App"], ["Access"], ["Updated"], ["Actions", "actions", true]]}>
                {apps.data.map((a) => (
                  <tr className="list-row" key={a.id}>
                    <td><div className="name-cell">
                      <span className="file-ico"><Icon name="globe" /></span>
                      <div><Link to="/apps/$name" params={{ name: a.name }}>{a.name}</Link><span className="sub">{bareUrl(a.url)}</span></div>
                    </div></td>
                    <td className="muted">{ACCESS_LABEL[a.access] ?? ""}</td>
                    <td className="muted"><TimeAgo iso={a.updatedAt} /></td>
                    <td className="actions">
                      <a className="btn sm" href={a.url} target="_blank" rel="noopener"><Icon name="external" />Visit<SrOnly>{` ${a.name} (opens in a new tab)`}</SrOnly></a>
                      <button className="btn sm" type="button" title="Open the deployed source as a new project" onClick={() => void openSource(a)}><Icon name="download" />Open source</button>
                      {a.access === "viewer" ? null : <Link className="btn sm" to="/share/$name" params={{ name: a.name }}><Icon name="users" />Share<SrOnly>{` ${a.name}`}</SrOnly></Link>}
                      {a.access === "owner" || a.org ? null /* org apps: leave the organization instead */
                        : <button className="btn sm danger" type="button" id={`leave-${a.id}`} aria-label={`Leave ${a.name}`} onClick={() => void leave(a)}>Leave</button>}
                    </td>
                  </tr>
                ))}
              </DataTable>
            ) : <EmptyState title="Nothing deployed yet">Open a project and press Deploy, or run cresslet deploy.</EmptyState>}
        </div>
      </section>
    </>
  );
}
