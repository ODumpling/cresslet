// #/admin/<name> (site admins): one site: its deploys, storage and overview, with delete, restore and purge.
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import type * as API from "../../../api-types.ts";
import { api, meta } from "../../lib/api.ts";
import { ago, bareUrl, fmtBytes, ownerText, STATUS } from "../../lib/format.ts";
import { useAlive, useView } from "../../lib/hooks.ts";
import { Stat, StatusPill, UsageBar } from "../../ui/bits.tsx";
import { ExtLink } from "../../ui/icons.tsx";
import { AdminView, useAdminLoad, useAgain } from "./AdminPage.tsx";
import { SiteActions } from "./Sites.tsx";

export function AdminSite() {
  const { name } = useParams({ from: "/admin/$name" });
  useView("admin", `${name} · Admin`);
  const navigate = useNavigate();
  const alive = useAlive();
  const loaded = useAdminLoad(async () => {
    const [d, m] = await Promise.all([api<API.AdminSite>(`/v1/admin/sites/${encodeURIComponent(name)}`), meta()]);
    return { d, customDomains: m.customDomains };
  }, [name]);
  const again = useAgain(loaded.reload);
  const s = loaded.data?.d.site;
  return (
    <AdminView
      loaded={loaded}
      title={<><Link to="/admin">Sites</Link>{" / "}{name}</>}
      sub={s ? (s.owner ? `Owned by ${ownerText(s.owner)}` : "Anonymous site") : ""}
      retryFocus="heading"
      actions={({ d }) => (
        <>
          {d.site.status === "deleted" ? null : <ExtLink href={d.site.url} className="btn">Visit</ExtLink>}
          <SiteActions site={d.site} after={(action) => {
            if (!alive.current) return;
            if (action === "purge") void navigate({ to: "/admin" });
            else void again();
          }} />
        </>
      )}
    >
      {({ d, customDomains }) => <SiteBody d={d} customDomains={customDomains} />}
    </AdminView>
  );
}

const Kv = ({ pairs }: { pairs: [string, ReactNode][] }) => (
  <dl className="kv">{pairs.map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>])}</dl>
);

function SiteBody({ d, customDomains }: { d: API.AdminSite; customDomains: boolean | undefined }) {
  const s = d.site, dep = s.currentDeploy, rt = d.runtime;
  const db = d.database;
  return (
    <>
      {s.status === "deleted" ? (
        <div className="banner deleted">
          <StatusPill s="deleted" />
          <span>{`${ago(s.deletedAt)}. Offline and hidden from its owner; purged with its data ${ago(s.purgeAt)} unless restored.`}</span>
        </div>
      ) : dep ? (
        <div className="banner">
          <StatusPill s="live" text="Live" />
          <span><span className="mono">{dep.id}</span>{` deployed ${ago(dep.createdAt)} via ${dep.source}`}</span>
        </div>
      ) : <div className="banner">Nothing deployed yet.</div>}
      <div className="stats">
        <Stat label="Status" value={STATUS[s.status]} sub={rt.running ? `pid ${rt.pid}` : s.server ? "Starts on the next request" : "Static site"}
          extra={<i className="dot" aria-hidden="true" data-s={s.status} />} />
        <Stat label="Site size" value={fmtBytes(s.usage.deploys)} sub={`${d.deploys.length} deploy${d.deploys.length === 1 ? "" : "s"} kept${dep ? ` · current ${fmtBytes(dep.bytes)}` : ""}`} />
        {/* `database` is null unless you own the site or are one of its admins: site admins see its size, not its tables. */}
        <Stat label="Database" value={s.usage.database ? fmtBytes(s.usage.database) : "—"}
          sub={!db ? (s.usage.database ? "Tables visible to the owner and its admins" : "No database yet") : db.error ? "Couldn't read" : !db.tables.length ? "No database yet" : `${db.tables.length} tables · ${db.tables.reduce((n, t) => n + t.rows, 0).toLocaleString()} rows`} />
        <Stat label="Files" value={fmtBytes(s.usage.files)} sub={`${fmtBytes(s.usage.total)} total on disk`} />
      </div>
      <div className="detail-grid">
        <div className="panel">
          <h2>Overview</h2>
          <Kv pairs={[
            ["URL", s.status === "deleted" ? s.url : <ExtLink href={s.url}>{bareUrl(s.url)}</ExtLink>],
            ["Domains", d.domains.length
              ? <span>
                {d.domains.map((x, i) => <Fragment key={x.domain}>{i ? ", " : null}{x.verified ? <ExtLink href={`https://${x.domain}`}>{x.domain}</ExtLink> : `${x.domain} (unverified)`}</Fragment>)}
                {customDomains === false ? " · custom domains are off on this server: none can be added or verified" : null}
              </span>
              : customDomains === false ? "Custom domains are off on this server" : "—"],
            ["Owner", s.owner ? `${s.owner.email}${s.owner.github ? ` (@${s.owner.github})` : ""}` : `Anonymous${s.expiresAt ? `, expires ${ago(s.expiresAt)}` : ""}`],
            ["Server", s.server ? `Yes${s.crons ? ` · ${s.crons} cron${s.crons > 1 ? "s" : ""}` : ""}` : "Static only"],
            ["Secrets", String(d.secrets)],
            ["Created", new Date(s.createdAt).toLocaleString()],
            ["App ID", <span className="mono">{s.id}</span>],
          ]} />
          <h2 className="mt">Storage</h2>
          <UsageBar u={s.usage} />
        </div>
        <div className="stack">
          <div className="panel">
            <h2>Deploys</h2>
            {d.deploys.length ? (
              // Focusable, so a keyboard can scroll it when it's wider than the panel.
              <div className="scroll-x" tabIndex={0} role="region" aria-label="Deploys">
                <table className="table">
                  <thead><tr>{["Deploy", "Size", "When"].map((h, i) => <th key={h} scope="col" className={i ? "num" : ""}>{h}</th>)}</tr></thead>
                  <tbody>
                    {d.deploys.map((x) => (
                      <tr key={x.id}>
                        <td><span><span className="mono">{x.id}</span>{x.current ? <span className="badge">live</span> : null}</span></td>
                        <td className="num">{fmtBytes(x.bytes)}</td>
                        <td className="num">{ago(x.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted small">No deploys.</p>}
          </div>
        </div>
      </div>
    </>
  );
}
