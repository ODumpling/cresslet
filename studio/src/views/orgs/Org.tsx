// #/orgs/<name>: one organization: its members (admins change roles, add and remove members) and its apps. Uses the
// admin pages' layout; a site admin who isn't a member manages it from here too.
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json } from "../../lib/api.ts";
import { ORG_ROLE_LABEL, personText, when } from "../../lib/format.ts";
import { useAlive, useView } from "../../lib/hooks.ts";
import { loadMyOrgs, useSession } from "../../lib/session.ts";
import { toast } from "../../lib/toast.tsx";
import { Field, FormError } from "../../ui/bits.tsx";
import { ExtLink, Icon } from "../../ui/icons.tsx";
import { AdminView, CANCELLED, RefreshButton, RowAction, useAdminLoad, useAgain } from "../admin/AdminPage.tsx";

type Member = API.OrgDetail["members"][number];

export function Org() {
  const { name } = useParams({ from: "/orgs/$name" });
  const loaded = useAdminLoad(() => api<API.OrgDetail>(`/v1/orgs/${encodeURIComponent(name)}`), [name]);
  const o = loaded.data?.org;
  useView("admin", o ? `${o.title ?? o.name} · Organizations` : null, "orgs");
  const d = loaded.data;
  return (
    <AdminView
      loaded={loaded}
      title={o ? <><Link to="/orgs">Organizations</Link>{" / "}{o.title ?? o.name}</> : name}
      sub={d ? [d.org.title ? d.org.name : null, d.role ? `You're ${d.role === "admin" ? "an admin" : "a member"}` : "You manage it as a site admin"].filter(Boolean).join(" · ") : ""}
      actions={() => <RefreshButton reload={loaded.reload} />}
      retry={false}
      errorText={(e) => (e.status === 404 ? "This organization doesn't exist, or you're not in it." : `Could not load: ${e.message}`)}
    >
      {(d) => <OrgBody d={d} reload={loaded.reload} />}
    </AdminView>
  );
}

function OrgBody({ d, reload }: { d: API.OrgDetail; reload: () => Promise<boolean> }) {
  const name = d.org.name;
  const again = useAgain(reload);
  const [formKey, setFormKey] = useState(0);
  return (
    <div className="detail-grid">
      <div className="stack">
        <div className="panel">
          <h2 id="org-members-title" tabIndex={-1}>{`Members (${d.members.length})`}</h2>
          <ul className="list" aria-label="Members">
            {d.members.map((m) => <MemberRow key={`${m.id}:${m.role}`} d={d} m={m} again={again} />)}
          </ul>
        </div>
        <div className="panel">
          <h2>{`Apps (${d.apps.length})`}</h2>
          {d.apps.length ? (
            <ul className="list" aria-label="Apps">
              {d.apps.map((a) => (
                <li className="list-row" key={a.name}>
                  <div className="tok">
                    {d.role
                      ? a.kind === "page"
                        ? <Link to="/share/$name" params={{ name: a.name }}>{a.name}</Link>
                        : <Link to="/apps/$name" params={{ name: a.name }}>{a.name}</Link>
                      : <strong>{a.name}</strong>}
                    <span className="meta">{`${a.kind === "page" ? "Artifact" : "App"} · updated ${when(a.updatedAt)}`}</span>
                  </div>
                  <ExtLink href={a.url} className="btn sm">Visit</ExtLink>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">No apps yet. An app's owner moves it in from its Share page.</p>}
        </div>
      </div>
      {d.canManage ? <AddMemberForm key={formKey} name={name} done={() => {
        flushSync(() => setFormKey((k) => k + 1)); // a fresh form
        void again(() => document.getElementById("org-member-email"));
      }} /> : null}
    </div>
  );
}

function MemberRow({ d, m, again }: { d: API.OrgDetail; m: Member; again: (focus?: () => HTMLElement | null) => Promise<void> }) {
  const name = d.org.name;
  const { accountId } = useSession();
  const navigate = useNavigate();
  const alive = useAlive();
  const [role, setRole] = useState<API.OrgRole>(m.role);
  const me = m.id === accountId;
  const memberUrl = `/v1/orgs/${encodeURIComponent(name)}/members/${encodeURIComponent(m.id)}`;
  const meta = [ORG_ROLE_LABEL[m.role], m.disabled ? "disabled" : null, `added ${when(m.createdAt)}`].filter(Boolean).join(" · ");

  async function changeRole(value: API.OrgRole) {
    if (me && value === "member" && !confirm(`Make yourself a member of ${name}? You won't be able to manage it any more.`)) return;
    setRole(value);
    try {
      const r = (await api<{ role: API.OrgRole }>(memberUrl, json("PUT", { role: value }))).role;
      toast(`${personText(m)} is now ${ORG_ROLE_LABEL[r].toLowerCase()}`);
      if (alive.current) void again(); // its subtitle, and (yourself) what you can still do
    } catch (e) {
      toast(`Could not change the role: ${errorMessage(e)}`);
      if (alive.current) setRole(m.role);
    }
  }

  return (
    <li className="list-row">
      <div className="tok">
        <strong>{personText(m)}{me ? <span className="badge">you</span> : null}</strong>
        <span className="meta">{meta}</span>
      </div>
      {d.canManage ? (
        <select className="input role-select" aria-label={`Role for ${personText(m)}`} value={role} onChange={(e) => void changeRole(e.target.value as API.OrgRole)}>
          {(["member", "admin"] as const).map((v) => <option key={v} value={v}>{ORG_ROLE_LABEL[v]}</option>)}
        </select>
      ) : null}
      {d.canManage || me ? (
        <RowAction
          label={me ? "Leave" : "Remove"}
          aria={me ? `Leave ${name}` : `Remove ${personText(m)}`}
          danger
          done={me ? `You left ${name}` : `Removed ${personText(m)}`}
          run={async () => {
            if (!confirm(me ? `Leave ${name}? You lose access to its apps.` : `Remove ${personText(m)} from ${name}? They lose access to its apps.`)) throw CANCELLED;
            await api(memberUrl, { method: "DELETE" });
          }}
          after={() => {
            if (me && d.role) { // you left (as a site admin you still manage it, but its page is the admin's)
              void loadMyOrgs();
              if (alive.current) void navigate({ to: "/orgs" });
            } else void again(() => document.getElementById("org-members-title"));
          }}
        />
      ) : null}
    </li>
  );
}

function AddMemberForm({ name, done }: { name: string; done: () => void }) {
  const alive = useAlive();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<API.OrgRole>("member");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await api<{ member: { email: string; role: API.OrgRole } }>(`/v1/orgs/${encodeURIComponent(name)}/members`, json("POST", { email: email.trim(), role }));
      toast(`Added ${r.member.email} as ${ORG_ROLE_LABEL[r.member.role].toLowerCase()}`);
      if (alive.current) done();
    } catch (x) {
      if (!alive.current) return;
      flushSync(() => {
        setErr(errorMessage(x));
        setBusy(false);
      });
      document.getElementById("org-member-email")?.focus();
    }
  }
  return (
    <form className="panel form grant-form" aria-label="Add a member" onInput={() => setErr("")} onSubmit={(e) => void submit(e)}>
      <h2>Add a member</h2>
      <Field label="Email" htmlFor="org-member-email" hint="The email on their Cresslet account. Someone new to this server needs a site admin's invite first.">
        <input className="input" id="org-member-email" type="email" required maxLength={254} autoComplete="off" spellCheck={false}
          aria-describedby="org-member-email-hint" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Role" htmlFor="org-member-role">
        <select className="input" id="org-member-role" value={role} onChange={(e) => setRole(e.target.value as API.OrgRole)}>
          <option value="member">Member: deploy and change the organization's apps</option>
          <option value="admin">Admin: also own them and manage members</option>
        </select>
      </Field>
      <FormError text={err} />
      <div className="row start">
        <button className="btn primary" type="submit" disabled={busy}><Icon name="plus" />Add member</button>
      </div>
    </form>
  );
}
