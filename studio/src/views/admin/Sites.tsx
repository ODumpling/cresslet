// /admin (site admins): every site on this server, with delete, restore and purge.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type * as API from "../../../api-types.ts";
import { api, errorMessage } from "../../lib/api.ts";
import { ago, bareUrl, fmtBytes, ownerText } from "../../lib/format.ts";
import { useView } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";
import { Stat, StatusPill, TimeAgo, UsageBar } from "../../ui/bits.tsx";
import { Icon, SrOnly } from "../../ui/icons.tsx";
import { AdminView, CANCELLED, RefreshButton, RowAction, shownText, useAdminLoad, useAgain } from "./AdminPage.tsx";

export type SiteAction = "delete" | "restore" | "purge";

/** Runs a site action (confirmed first): toasts the outcome; throws CANCELLED if it didn't happen. */
async function siteAction(site: API.Site, action: SiteAction) {
  try {
    if (action === "delete") {
      if (!confirm(`Delete ${site.name}? It goes offline now and can be restored until it's purged.`)) throw CANCELLED;
      await api(`/v1/admin/sites/${encodeURIComponent(site.name)}`, { method: "DELETE" });
      toast(`${site.name} deleted`);
    } else if (action === "restore") {
      await api(`/v1/admin/sites/${encodeURIComponent(site.name)}/restore`, { method: "POST", body: "{}" });
      toast(`${site.name} restored`);
    } else {
      const typed = prompt(`Permanently delete ${site.name}, its database and files? This can't be undone.\n\nType the site name to confirm:`);
      if (typed === null) throw CANCELLED;
      if (typed.trim() !== site.name) {
        toast("Name didn't match. Nothing was deleted.");
        throw CANCELLED;
      }
      await api(`/v1/admin/sites/${encodeURIComponent(site.name)}?purge=1`, { method: "DELETE" });
      toast(`${site.name} permanently deleted`);
    }
  } catch (e) {
    if (e !== CANCELLED) toast(`Could not ${action} ${site.name}: ${errorMessage(e)}`);
    throw CANCELLED;
  }
}

/** A site's Delete, or (deleted) Restore and Purge; `after` once one worked. */
export function SiteActions({ site, after }: { site: API.Site; after: (action: SiteAction) => unknown }) {
  const btn = (label: string, action: SiteAction, danger?: boolean) => (
    <RowAction key={action} label={label} aria={`${label} ${site.name}`} danger={danger} run={() => siteAction(site, action)} after={() => after(action)} />
  );
  return site.status === "deleted" ? <>{btn("Restore", "restore")}{btn("Purge", "purge", true)}</> : btn("Delete", "delete", true);
}

type Filter = "live" | "deleted" | "all";
/** The filter and search, kept across visits. */
const adminView: { filter: Filter; q: string } = { filter: "live", q: "" };

export function AdminSites() {
  useView("admin", "Sites · Admin");
  const loaded = useAdminLoad(() => api<API.AdminSites>("/v1/admin/sites"));
  return (
    <AdminView loaded={loaded} title="Sites" sub="Every site on this server" actions={() => <RefreshButton reload={loaded.reload} />}>
      {(d) => <Sites d={d} reload={loaded.reload} />}
    </AdminView>
  );
}

function Sites({ d, reload }: { d: API.AdminSites; reload: () => Promise<boolean> }) {
  const { totals, sites, retentionDays } = d;
  const again = useAgain(reload);
  const [filter, setFilterState] = useState(adminView.filter);
  const [q, setQState] = useState(adminView.q);
  const setFilter = (f: Filter) => setFilterState((adminView.filter = f));
  const setQ = (v: string) => setQState((adminView.q = v));
  const u = totals.usage;
  const counts = { live: totals.live, deleted: totals.deleted, all: totals.sites };
  const needle = q.trim().toLowerCase();
  const rows = sites.filter((s) =>
    (filter === "all" || (filter === "deleted") === (s.status === "deleted")) &&
    (!needle || [s.name, s.owner?.email, s.owner?.github, ...s.domains].some((v) => v?.toLowerCase().includes(needle))));
  return (
    <>
      <div className="stats">
        <Stat label="Sites" value={String(totals.live)} sub={`${totals.anonymous} anonymous · ${totals.deleted} deleted`} />
        <Stat label="Running" value={<>{String(totals.running)}<small>{`of ${totals.live}`}</small></>} sub="Idle sites stop after a few minutes" />
        <Stat label="Disk used" value={fmtBytes(u.total)} sub={`Site ${fmtBytes(u.deploys)} · files ${fmtBytes(u.files)}`} />
        <Stat label="Databases" value={fmtBytes(u.database)} sub={`Across ${sites.filter((s) => s.usage.database > 0).length} sites`} />
      </div>
      <div className="panel"><h2>Storage</h2><UsageBar u={u} /></div>
      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <input type="search" className="input" placeholder="Search sites, owners, domains" aria-label="Search sites" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg" role="group" aria-label="Show">
          {([["live", "Live"], ["deleted", "Deleted"], ["all", "All"]] as const).map(([k, l]) => (
            <button key={k} type="button" id={`filter-${k}`} data-k={k} aria-pressed={k === filter} onClick={() => setFilter(k)}>{`${l} ${counts[k]}`}</button>
          ))}
        </div>
        <p className="sr-only" role="status">{shownText(rows.length, "site")}</p>
      </div>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Sites</caption>
          <thead><tr>
            {["Site", "Owner", "Status", "Site size", "Database", "Updated", "Actions"].map((h, i) => (
              <th key={h} scope="col" className={i === 3 || i === 4 ? "num" : ""}>{i === 6 ? <SrOnly>{h}</SrOnly> : h}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.length ? rows.map((s) => (
              <tr key={s.id} data-deleted={s.status === "deleted" ? "" : undefined}>
                <td>
                  <Link to="/admin/$name" params={{ name: s.name }}>{s.name}</Link>
                  <span className="sub">{s.domains[0] ?? bareUrl(s.url)}</span>
                </td>
                <td className={s.owner ? "" : "muted"}>{ownerText(s.owner)}</td>
                <td>
                  <StatusPill s={s.status} />
                  {s.status === "deleted" ? <span className="sub">{`purged ${ago(s.purgeAt)}`}</span> : null}
                </td>
                <td className="num">{fmtBytes(s.usage.deploys + s.usage.files)}</td>
                <td className="num">{s.usage.database ? fmtBytes(s.usage.database) : "—"}</td>
                <td><TimeAgo iso={s.updatedAt} /></td>
                <td className="actions"><SiteActions site={s} after={() => void again()} /></td>
              </tr>
            )) : <tr><td colSpan={7} className="empty">{needle ? "No sites match." : "No sites here."}</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small">{`Deleted sites go offline and can be restored for ${retentionDays} days, then they're purged with their data.`}</p>
    </>
  );
}
