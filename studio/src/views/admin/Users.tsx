// /admin-users (site admins): every account on this server; invite, make admin, disable.
import { Link } from "@tanstack/react-router";
import { Fragment, type FormEvent, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json } from "../../lib/api.ts";
import { ownerText } from "../../lib/format.ts";
import { useAlive, useView } from "../../lib/hooks.ts";
import { useSession } from "../../lib/session.ts";
import { toast } from "../../lib/toast.tsx";
import { DataTable, Field, FormError, Stat, StatusPill, TimeAgo } from "../../ui/bits.tsx";
import { Icon } from "../../ui/icons.tsx";
import { AdminView, CANCELLED, RefreshButton, RowAction, shownText, useAdminLoad, useAgain } from "./AdminPage.tsx";

type AdminAccount = API.AdminAccounts["accounts"][number];
const ACCOUNT_STATUS: Record<API.AccountStatus, [string, string]> = { active: ["live", "Active"], invited: ["idle", "Invited"], disabled: ["deleted", "Disabled"] };
type Filter = "all" | API.AccountStatus;
/** The filter and search, kept across visits. */
const adminUsersView: { filter: Filter; q: string } = { filter: "all", q: "" };

export function AdminUsers() {
  useView("admin", "Users · Admin", "admin-users");
  const loaded = useAdminLoad(() => Promise.all([
    api<API.AdminAccounts>("/v1/admin/accounts"),
    api<{ orgs: API.AdminOrg[] }>("/v1/admin/orgs").then((r) => r.orgs, (): API.AdminOrg[] => []),
  ]));
  return (
    <AdminView loaded={loaded} title="Users" sub="Every account on this server" actions={() => <RefreshButton reload={loaded.reload} />}>
      {([d, orgs]) => <Users d={d} orgs={orgs} reload={loaded.reload} />}
    </AdminView>
  );
}

function Users({ d, orgs, reload }: { d: API.AdminAccounts; orgs: API.AdminOrg[]; reload: () => Promise<boolean> }) {
  const again = useAgain(reload);
  const { accountId } = useSession();
  const [filter, setFilterState] = useState(adminUsersView.filter);
  const [q, setQState] = useState(adminUsersView.q);
  const setFilter = (f: Filter) => setFilterState((adminUsersView.filter = f));
  const setQ = (v: string) => setQState((adminUsersView.q = v));
  const [formKey, setFormKey] = useState(0);
  const t = d.totals;
  const counts = { all: t.accounts, active: t.active, invited: t.invited, disabled: t.disabled };
  const needle = q.trim().toLowerCase();
  const rows = d.accounts.filter((a) => (filter === "all" || a.status === filter) &&
    (!needle || [a.email, a.github, ...a.orgs.map((o) => o.name)].some((v) => v?.toLowerCase().includes(needle))));

  const actions = (a: AdminAccount) => {
    const btn = (label: string, aria: string, run: () => Promise<unknown>, done: string, danger?: boolean) => (
      <RowAction key={label} label={label} aria={`${aria} ${a.email}`} run={run} done={done} danger={danger} after={() => void again()} />
    );
    const patch = (input: { siteAdmin?: boolean; disabled?: boolean }) => () => api(`/v1/admin/accounts/${encodeURIComponent(a.id)}`, json("PATCH", input));
    const me = a.id === accountId, out = [];
    if (a.status === "invited") {
      out.push(btn("Withdraw invite", "Withdraw the invite for", async () => {
        if (!confirm(`Withdraw the invite for ${a.email}? They won't be able to sign in.`)) throw CANCELLED;
        await api(`/v1/admin/accounts/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      }, `Withdrew the invite for ${a.email}`, true));
    }
    if (!me && !a.siteAdminFromConfig) {
      out.push(a.siteAdmin
        ? btn("Remove admin", "Remove the site admin role from", patch({ siteAdmin: false }), `${a.email} is no longer a site admin`)
        : btn("Make admin", "Make site admin:", patch({ siteAdmin: true }), `${a.email} is now a site admin`));
      if (a.status === "disabled") out.push(btn("Enable", "Enable", patch({ disabled: false }), `${a.email} can sign in again`));
      else if (a.status === "active") {
        out.push(btn("Disable", "Disable", async () => {
          if (!confirm(`Disable ${a.email}? They're signed out everywhere and can't sign in or deploy. Their sites keep serving.`)) throw CANCELLED;
          await patch({ disabled: true })();
        }, `${a.email} is disabled`, true));
      }
    }
    return out;
  };

  return (
    <>
      <div className="stats">
        <Stat label="Accounts" value={String(t.accounts)} sub={`${t.siteAdmins} site admin${t.siteAdmins === 1 ? "" : "s"}`} />
        <Stat label="Active" value={String(t.active)} sub="Signed in at least once" />
        <Stat label="Invited" value={String(t.invited)} sub="Not signed in yet" />
        <Stat label="Disabled" value={String(t.disabled)} sub="Can't sign in; their sites keep serving" />
      </div>
      <div className="detail-grid">
        <div className="stack">
          <div className="panel">
            <h2>How accounts work</h2>
            <p className="muted small">{`Everyone signs in with GitHub. ${d.openSignup ? "Signup is open: anyone can create an account." : "Signup is closed: only invited people (and accounts that already exist) can sign in."} Disabling an account signs it out everywhere and blocks its login, tokens and deploys; its sites keep serving until you delete them on the Sites page.`}</p>
          </div>
        </div>
        <InviteForm key={formKey} orgs={orgs} openSignup={d.openSignup} done={() => {
          flushSync(() => setFormKey((k) => k + 1)); // a fresh form, as before the invite
          void again(() => document.getElementById("invite-account-email"));
        }} />
      </div>
      <div className="toolbar">
        <h2 className="toolbar-title">Accounts</h2>
        <div className="search">
          <Icon name="search" />
          <input type="search" className="input" placeholder="Search accounts, organizations" aria-label="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg" role="group" aria-label="Show">
          {([["all", "All"], ["active", "Active"], ["invited", "Invited"], ["disabled", "Disabled"]] as const).map(([k, l]) => (
            <button key={k} type="button" data-k={k} aria-pressed={k === filter} onClick={() => setFilter(k)}>{`${l} ${counts[k]}`}</button>
          ))}
        </div>
        <p className="sr-only" role="status">{shownText(rows.length, "account")}</p>
      </div>
      <DataTable label="Accounts table" caption="Accounts, oldest first"
        heads={[["Account"], ["Status"], ["Role"], ["Organizations"], ["Apps", "num"], ["Last active"], ["Actions", undefined, true]]}>
        {rows.length ? rows.map((a) => {
          const [s, label] = ACCOUNT_STATUS[a.status];
          return (
            <tr key={a.id} data-deleted={a.status === "disabled" ? "" : undefined}>
              <td>
                <span>{a.email}{a.id === accountId ? <span className="badge">you</span> : null}</span>
                <span className="sub">{a.github ? `@${a.github}` : a.invitedBy ? `invited by ${ownerText(a.invitedBy)}` : "no GitHub login yet"}</span>
              </td>
              <td><StatusPill s={s} text={label} /></td>
              <td>{a.siteAdmin
                ? <span>Site admin{a.siteAdminFromConfig ? <span className="sub">in the server's config</span> : null}</span>
                : <span className="muted">—</span>}</td>
              <td className="orgs">{a.orgs.length
                ? <span>{a.orgs.map((o, i) => (
                  <Fragment key={o.name}>{i ? ", " : null}<Link to="/orgs/$name" params={{ name: o.name }}>{o.name}</Link>{o.role === "admin" ? " (admin)" : null}</Fragment>
                ))}</span>
                : <span className="muted">—</span>}</td>
              <td className="num">{String(a.apps)}</td>
              <td>{a.lastActiveAt ? <TimeAgo iso={a.lastActiveAt} /> : <span className="muted">never</span>}</td>
              <td className="actions multi">{actions(a)}</td>
            </tr>
          );
        }) : <tr><td colSpan={7} className="empty">{needle ? "No accounts match." : "No accounts here."}</td></tr>}
      </DataTable>
      <p className="muted small">Apps: apps and artifacts the account owns personally. Last active: the last time one of its tokens was used.</p>
    </>
  );
}

/** Invite: sets up the account; they sign in with GitHub using that email (no email is sent). */
function InviteForm({ orgs, openSignup, done }: { orgs: API.AdminOrg[]; openSignup: boolean; done: () => void }) {
  const alive = useAlive();
  const [email, setEmail] = useState("");
  const [asAdmin, setAsAdmin] = useState(false);
  const [org, setOrg] = useState("");
  const [orgRole, setOrgRole] = useState("member");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await api<{ account: { email: string } }>("/v1/admin/accounts", json("POST", { email: email.trim(), siteAdmin: asAdmin, ...(org ? { org, orgRole } : {}) }));
      toast(`Invited ${r.account.email}. They can sign in with GitHub now.`);
      if (alive.current) done();
    } catch (x) {
      if (!alive.current) return;
      flushSync(() => {
        setErr(`Could not invite: ${errorMessage(x)}`);
        setBusy(false);
      });
      document.getElementById("invite-account-email")?.focus();
    }
  }
  return (
    <form className="panel form grant-form" aria-label="Invite someone" onInput={() => setErr("")} onSubmit={(e) => void submit(e)}>
      <h2>Invite someone</h2>
      <Field label="Email" htmlFor="invite-account-email" hint={`They sign in with GitHub, with this as one of their verified emails${openSignup ? "" : ", even though signup is closed"}. No email is sent: let them know.`}>
        <input className="input" id="invite-account-email" type="email" required maxLength={254} autoComplete="off" spellCheck={false} placeholder="name@example.com"
          aria-describedby="invite-account-email-hint" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {orgs.length ? (
        <Field label="Organization (optional)" htmlFor="invite-account-org">
          <select className="input" id="invite-account-org" value={org} onChange={(e) => setOrg(e.target.value)}>
            <option value="">None</option>
            {orgs.map((o) => <option key={o.name} value={o.name}>{o.title ? `${o.title} (${o.name})` : o.name}</option>)}
          </select>
        </Field>
      ) : null}
      {orgs.length && org ? (
        <Field label="Organization role" htmlFor="invite-account-org-role">
          <select className="input" id="invite-account-org-role" value={orgRole} onChange={(e) => setOrgRole(e.target.value)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
      ) : null}
      <label className="check">
        <input type="checkbox" id="invite-account-admin" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
        <span>Site admin</span>
      </label>
      <FormError text={err} />
      <div className="row start">
        <button className="btn primary" type="submit" disabled={busy}><Icon name="plus" />Invite</button>
      </div>
    </form>
  );
}
