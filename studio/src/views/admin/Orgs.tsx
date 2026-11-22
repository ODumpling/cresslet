// #/admin-orgs (site admins): every organization; create and delete them.
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json, statusOf } from "../../lib/api.ts";
import { useAlive, useView } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";
import { DataTable, Field, FormError, TimeAgo } from "../../ui/bits.tsx";
import { Icon } from "../../ui/icons.tsx";
import { AdminView, CANCELLED, RefreshButton, RowAction, useAdminLoad, useAgain } from "./AdminPage.tsx";

export function AdminOrgs() {
  useView("admin", "Organizations · Admin", "admin-orgs");
  const loaded = useAdminLoad(() => api<{ orgs: API.AdminOrg[] }>("/v1/admin/orgs").then((r) => r.orgs));
  return (
    <AdminView loaded={loaded} title="Organizations" sub="Teams whose members share apps" actions={() => <RefreshButton reload={loaded.reload} />}>
      {(orgs) => <Orgs orgs={orgs} reload={loaded.reload} />}
    </AdminView>
  );
}

function Orgs({ orgs, reload }: { orgs: API.AdminOrg[]; reload: () => Promise<boolean> }) {
  const again = useAgain(reload);
  const [formKey, setFormKey] = useState(0);
  return (
    <div className="detail-grid">
      <div className="stack">
        <div className="panel">
          <h2>How organizations work</h2>
          <p className="muted small">An app moved into an organization belongs to it: the organization's admins own it, and its members can deploy and change it. Admins manage members. As a site admin you manage organizations, but you don't get access to their apps unless you're a member.</p>
        </div>
        <DataTable label="Organizations table" caption="Organizations"
          heads={[["Organization"], ["Members", "num"], ["Apps", "num"], ["Created"], ["Actions", undefined, true]]}>
          {orgs.length ? orgs.map((o) => (
            <tr key={o.name}>
              <td>
                <Link to="/orgs/$name" params={{ name: o.name }}>{o.title ?? o.name}</Link>
                {o.title ? <span className="sub mono">{o.name}</span> : null}
              </td>
              <td className="num">{String(o.members)}</td>
              <td className="num">{String(o.apps)}</td>
              <td><TimeAgo iso={o.createdAt} /></td>
              <td className="actions">
                <RowAction label="Delete" aria={`Delete ${o.name}`} danger done={`Deleted ${o.name}`} after={() => void again()} run={async () => {
                  if (!confirm(`Delete the organization ${o.name}? Its members lose its apps' access; apps must be moved out first.`)) throw CANCELLED;
                  await api(`/v1/admin/orgs/${encodeURIComponent(o.name)}`, { method: "DELETE" });
                }} />
              </td>
            </tr>
          )) : <tr><td colSpan={5} className="empty">No organizations yet.</td></tr>}
        </DataTable>
      </div>
      <NewOrgForm key={formKey} done={() => {
        flushSync(() => setFormKey((k) => k + 1)); // a fresh form
        void again(() => document.getElementById("org-name"));
      }} />
    </div>
  );
}

function NewOrgForm({ done }: { done: () => void }) {
  const alive = useAlive();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [admin, setAdmin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await api<{ org: { name: string } }>("/v1/admin/orgs", json("POST", { name: name.trim(), ...(title.trim() ? { title: title.trim() } : {}), admin: admin.trim() }));
      toast(`Created ${r.org.name}`);
      if (alive.current) done();
    } catch (x) {
      if (!alive.current) return;
      flushSync(() => {
        setErr(`Could not create it: ${errorMessage(x)}`);
        setBusy(false);
      });
      document.getElementById(statusOf(x) === 404 ? "org-admin" : "org-name")?.focus();
    }
  }
  return (
    <form className="panel form grant-form" aria-label="New organization" onInput={() => setErr("")} onSubmit={(e) => void submit(e)}>
      <h2>New organization</h2>
      <Field label="Name" htmlFor="org-name" hint="Lowercase letters, digits and single dashes, up to 40.">
        <input className="input mono" id="org-name" required maxLength={40} pattern="[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]|[a-z0-9]" autoComplete="off" spellCheck={false}
          placeholder="acme" aria-describedby="org-name-hint" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Display name (optional)" htmlFor="org-title">
        <input className="input" id="org-title" maxLength={100} autoComplete="off" placeholder="Acme Inc." value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="First admin" htmlFor="org-admin" hint="The email of an existing account. Admins add and remove members; invite new people on the Users page first.">
        <input className="input" id="org-admin" type="email" required maxLength={254} autoComplete="off" spellCheck={false} placeholder="name@example.com"
          aria-describedby="org-admin-hint" value={admin} onChange={(e) => setAdmin(e.target.value)} />
      </Field>
      <FormError text={err} />
      <div className="row start">
        <button className="btn primary" type="submit" disabled={busy}><Icon name="plus" />Create organization</button>
      </div>
    </form>
  );
}
