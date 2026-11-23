// /share/<app>: who has access to an app or an artifact (its owner and admins change it), the organization it's
// in, and invites.
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../api-types.ts";
import { api, errorMessage, json, meta } from "../lib/api.ts";
import { refocus, refocusId } from "../lib/focus.ts";
import { ACCESS_LABEL, pageName, personText, when } from "../lib/format.ts";
import { useAlive, useLoad, useView } from "../lib/hooks.ts";
import { loadMyOrgs, refreshAccount, session, useSession } from "../lib/session.ts";
import { toast } from "../lib/toast.tsx";
import { FormError } from "../ui/bits.tsx";

// What sharing lets each role do: an app's, or an artifact's.
const VIEWER_APP = "Viewer: see the app, logs, source and data";
const ADMIN_APP = "Admin: also deploy, roll back, secrets, domains and sharing (not deleting the app)";
const VIEWER_PAGE = "Viewer: open it, even when it's private";
const ADMIN_PAGE = "Admin: also replace its files, change who can open it and how long it's kept, and share it (not deleting it)";

const appPath = (name: string, rest = "") => `/v1/apps/${encodeURIComponent(name)}${rest}`;

export function Share() {
  const { name } = useParams({ from: "/share/$name" });
  const { user } = useSession();
  const navigate = useNavigate();
  useView("share", `Share ${name}`);
  useEffect(() => {
    if (!user) void navigate({ to: "/", replace: true });
  }, [user, navigate]);
  // Another app's page (or account) starts afresh: its form, its updates in flight.
  return user ? <SharePage key={`${user}\n${name}`} name={name} /> : null;
}

function SharePage({ name }: { name: string }) {
  const navigate = useNavigate();
  const alive = useAlive();
  const { accountId } = useSession();
  // An artifact: its title, and what sharing means for it.
  const page = useLoad(() => api<{ page: API.Page }>(`/v1/pages/${encodeURIComponent(name)}`).then((r) => r.page, () => null), [name]);
  const artifact = page.data ?? null;
  // Custom domains off on this server (CRESSLET_CUSTOM_DOMAINS=false): don't offer them in the role description.
  const [noDomains, setNoDomains] = useState(false);
  useEffect(() => {
    let live = true;
    void meta().then((m) => live && setNoDomains(m.customDomains === false));
    return () => void (live = false);
  }, []);
  // (your own row: /v1/me first, if it hasn't answered yet)
  const people = useLoad(async () => {
    if (!session().accountId) await refreshAccount();
    return api<API.Collaborators>(appPath(name, "/collaborators"));
  }, [name]);
  const org = useLoad(() => Promise.all([api<API.AppDetail>(appPath(name)), loadMyOrgs()]).then(([{ app }, orgs]) => ({ app, orgs })), [name]);

  async function removePerson(p: API.Person, me: boolean) {
    if (!confirm(me ? `Leave ${name}? You lose access to it until someone invites you again.` : `Remove ${personText(p)} from ${name}?`)) return;
    try {
      await api(appPath(name, `/collaborators/${encodeURIComponent(p.id)}`), { method: "DELETE" });
    } catch (e) {
      toast(`Could not remove: ${errorMessage(e)}`);
      return;
    }
    toast(me ? `You left ${name}` : `Removed ${personText(p)}`);
    if (!alive.current) return; // navigated away meanwhile
    if (me) return void navigate({ to: "/" });
    if (await people.reload()) refocusId("people-title");
  }

  async function cancelInvite(i: API.Collaborators["invites"][number]) {
    try {
      await api(appPath(name, `/invites/${encodeURIComponent(i.id)}`), { method: "DELETE" });
    } catch (e) {
      toast(`Could not cancel the invite: ${errorMessage(e)}`);
      return;
    }
    toast(`Cancelled the invite for ${i.email}`);
    if (!alive.current) return;
    if (await people.reload()) refocusId("people-title");
  }

  const who = (text: string, metaText: string, badge?: string | null) => (
    <div className="tok">
      <strong>{text}{badge ? <span className="badge">{badge}</span> : null}</strong>
      <span className="meta">{metaText}</span>
    </div>
  );
  const d = people.data;

  return (
    <main id="share" className="page narrow" aria-labelledby="share-title">
      <header className="page-head">
        <div>
          <h1 id="share-title" tabIndex={-1}>
            {artifact ? <><Link to="/artifacts">Artifacts</Link>{" / "}{`Share ${pageName(artifact)}`}</>
              : <><Link to="/">Projects</Link>{" / "}{`Share ${name}`}</>}
          </h1>
          <p className="muted" id="share-sub">{artifact
            ? "Invite accounts to this artifact. Viewers can open it even when it's private; admins can also change it."
            : "Invite accounts to this app. Viewers see it; admins can also change it."}</p>
        </div>
      </header>
      <section className="block" aria-labelledby="people-title">
        <div className="block-head"><h2 id="people-title" tabIndex={-1}>People with access</h2></div>
        <ul className="list" id="people" aria-labelledby="people-title">
          {people.error ? <li className="list-row error">{`Could not load who has access: ${people.error.message}`}</li>
            : !d ? <li className="list-row muted">Loading…</li>
            : (
              <>
                {d.org ? (
                  // In an organization: its admins own it (`owner` is just who last held it).
                  <li className="list-row">
                    {who(d.org.title ?? d.org.name, "Organization: its admins own this, its members can change it")}
                    <Link className="btn sm" to="/orgs/$name" params={{ name: d.org.name }} aria-label={`Members of ${d.org.name}`}>Members</Link>
                  </li>
                ) : <li className="list-row">{who(personText(d.owner), "Owner", d.owner.id === accountId ? "you" : null)}</li>}
                {d.collaborators.map((p) => {
                  const me = p.id === accountId;
                  return (
                    <li className="list-row" key={p.id}>
                      {who(personText(p), `added ${when(p.createdAt)}`, me ? "you" : null)}
                      <RoleSelect p={p} me={me} app={name} alive={alive} />
                      <button className="btn sm danger" type="button" id={`remove-${p.id}`} aria-label={me ? `Leave ${name}` : `Remove ${personText(p)}`}
                        onClick={() => void removePerson(p, me)}>{me ? "Leave" : "Remove"}</button>
                    </li>
                  );
                })}
                {d.invites.map((i) => (
                  <li className="list-row" key={i.id}>
                    {who(i.email, `${ACCESS_LABEL[i.role]} · invited ${when(i.createdAt)}`, "pending")}
                    <button className="btn sm" type="button" id={`cancel-${i.id}`} aria-label={`Cancel invite for ${i.email}`} onClick={() => void cancelInvite(i)}>Cancel invite</button>
                  </li>
                ))}
              </>
            )}
        </ul>
      </section>
      <OrgBlock name={name} data={org.data} alive={alive} reload={() => Promise.all([people.reload(), org.reload()])} />
      <section className="block" aria-labelledby="invite-form-title">
        {/* only the owner and admins may share: hidden until the list loads */}
        <InviteForm name={name} hidden={!d} alive={alive} reload={people.reload}
          viewerText={artifact ? VIEWER_PAGE : VIEWER_APP}
          adminText={artifact ? ADMIN_PAGE : noDomains ? ADMIN_APP.replace(/,? domains\b/, "") : ADMIN_APP} />
      </section>
    </main>
  );
}

/**
 * A collaborator's role. One update per row at a time, in order (a select can fire change per arrow key); only the
 * latest change updates the select, to what the server stored.
 */
function RoleSelect({ p, me, app, alive }: { p: API.Collaborators["collaborators"][number]; me: boolean; app: string; alive: RefObject<boolean> }) {
  const navigate = useNavigate();
  const [value, setValue] = useState<API.Access>(p.role);
  const row = useRef({ role: p.role, version: 0, saving: Promise.resolve(), demoted: false });
  // The list reloaded: what the server has now.
  const [seen, setSeen] = useState(p.role);
  if (seen !== p.role) {
    setSeen(p.role);
    setValue(p.role);
  }
  useEffect(() => void (row.current.role = p.role), [p.role]);

  function change(role: API.Access) {
    // Demoting yourself ends your access to this page: only after a confirmation.
    if (me && role === "viewer" && !confirm(`Make yourself a viewer of ${app}? You won't be able to change it or share it any more.`)) return;
    setValue(role);
    const r = row.current;
    const version = ++r.version; // only the latest change updates the row
    const url = appPath(app, `/collaborators/${encodeURIComponent(p.id)}`);
    r.saving = r.saving.then(async () => {
      if (r.demoted) return; // you made yourself a viewer: later changes would only be refused
      try {
        r.role = (await api<{ role: API.Access }>(url, json("PUT", { role }))).role;
      } catch (e) {
        toast(`Could not change the role: ${errorMessage(e)}`);
        if (version === r.version && alive.current) setValue(r.role);
        return;
      }
      if (me && r.role === "viewer") {
        r.demoted = true;
        if (alive.current) void navigate({ to: "/" }); // no longer allowed here (unless you already left the page)
        toast(`You're now a viewer of ${app}`);
        return;
      }
      if (version !== r.version) return;
      if (alive.current) setValue(r.role);
      toast(`${personText(p)} is now ${ACCESS_LABEL[r.role]!.toLowerCase()}`);
    });
  }

  return (
    <select className="input role-select" id={`role-${p.id}`} aria-label={`Role for ${personText(p)}`} value={value}
      onChange={(e) => change(e.target.value as API.Access)}>
      {(["viewer", "admin"] as const).map((v) => <option key={v} value={v}>{ACCESS_LABEL[v]}</option>)}
    </select>
  );
}

type OrgData = { app: API.AppDetail["app"]; orgs: API.MyOrg[] };

/** Moving the app into one of your organizations, or back out: for its owner (in an organization: an org admin). */
function OrgBlock({ name, data, alive, reload }: { name: string; data?: OrgData; alive: RefObject<boolean>; reload: () => Promise<unknown> }) {
  const hidden = !data || data.app.access !== "owner" || (!data.orgs.length && !data.app.org);
  return (
    <section className="block" id="org-block" hidden={hidden} aria-labelledby="org-block-title">
      {data ? <OrgForm key={data.app.org?.name ?? ""} name={name} data={data} alive={alive} reload={reload} /> : null}
    </section>
  );
}

function OrgForm({ name, data: { app, orgs }, alive, reload }: { name: string; data: OrgData; alive: RefObject<boolean>; reload: () => Promise<unknown> }) {
  const org = app.org;
  const current = org?.name ?? "";
  const [to, setTo] = useState(current);
  const [moving, setMoving] = useState(false);
  const inMine = !org || orgs.some((o) => o.name === org.name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const dest = to || null;
    if ((dest ?? "") === current) return void toast("It's already there.");
    if (!confirm(dest ? `Move ${name} into ${dest}? Its admins will own it.` : `Make ${name} your personal app? The organization's members lose access to it.`)) return;
    setMoving(true);
    try {
      await api(appPath(name, "/org"), json("PUT", { org: dest }));
      toast(dest ? `Moved ${name} into ${dest}` : `${name} is your personal app now`);
    } catch (x) {
      toast(`Could not move it: ${errorMessage(x)}`);
    }
    if (!alive.current) return;
    flushSync(() => setMoving(false));
    await reload();
    if (alive.current) refocus();
  }

  return (
    <form id="org-form" className="panel form" aria-labelledby="org-block-title" onSubmit={(e) => void submit(e)}>
      <h2 id="org-block-title">Organization</h2>
      <p className="muted small" id="org-form-text">{org
        ? `In ${org.title ?? org.name}: its admins own it and its members can deploy and change it. Moved out, it becomes your personal app.`
        : "Move it into an organization you're in: the organization's admins will own it, and its members can deploy and change it. People you've shared it with keep their access."}</p>
      <div className="field">
        <label htmlFor="org-select">Belongs to</label>
        <select className="input" id="org-select" aria-describedby="org-form-text" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{org ? "Nobody: make it my personal app" : "Nobody: my personal app"}</option>
          {inMine ? null : <option value={org.name}>{org.title ?? org.name}</option>}
          {orgs.map((o) => <option key={o.name} value={o.name}>{o.title ? `${o.title} (${o.name})` : o.name}</option>)}
        </select>
      </div>
      <div className="row start"><button className="btn" id="org-move" type="submit" disabled={moving}>Move</button></div>
    </form>
  );
}

function InviteForm({ name, hidden, alive, reload, viewerText, adminText }: {
  name: string;
  hidden: boolean;
  alive: RefObject<boolean>;
  reload: () => Promise<boolean>;
  viewerText: string;
  adminText: string;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<API.Access>("viewer");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const send = useRef<HTMLButtonElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSending(true);
    try {
      const r = await api<{ invite: { email: string; role: API.Access } }>(appPath(name, "/collaborators"), json("POST", { email, role }));
      toast(`Invited ${r.invite.email} as ${ACCESS_LABEL[r.invite.role]!.toLowerCase()}`);
      if (!alive.current) return;
      setEmail("");
      setRole("viewer");
      await reload();
    } catch (err) {
      if (alive.current) setError(`Could not invite: ${errorMessage(err)}`);
      else toast(`Could not invite: ${errorMessage(err)}`);
    } finally {
      if (alive.current) {
        flushSync(() => setSending(false));
        if (document.activeElement === document.body) send.current?.focus(); // disabling it dropped focus
      }
    }
  }

  return (
    <form id="invite-form" className="panel form" aria-labelledby="invite-form-title" hidden={hidden} onInput={() => setError("")} onSubmit={(e) => void submit(e)}>
      <h2 id="invite-form-title">Invite</h2>
      <div className="field">
        <label htmlFor="invite-email">Email</label>
        <input className="input" id="invite-email" type="email" required maxLength={254} autoComplete="off" spellCheck={false} aria-describedby="invite-email-hint"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <p className="muted small" id="invite-email-hint">The email on their Cresslet account (shown in their Settings). They accept the invite when they log in; no email is sent.</p>
      </div>
      <div className="field">
        <label htmlFor="invite-role">Role</label>
        <select className="input" id="invite-role" value={role} onChange={(e) => setRole(e.target.value as API.Access)}>
          <option value="viewer">{viewerText}</option>
          <option value="admin" id="invite-role-admin">{adminText}</option>
        </select>
      </div>
      <FormError id="invite-error" text={error} />
      <div className="row start"><button className="btn primary" id="invite-send" type="submit" disabled={sending} ref={send}>Send invite</button></div>
    </form>
  );
}
