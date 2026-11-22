// /admin-credits (site admins): AI credit use across every account; give and take back credits.
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type * as API from "../../../api-types.ts";
import { api } from "../../lib/api.ts";
import { useView } from "../../lib/hooks.ts";
import { DataTable, Stat, TimeAgo } from "../../ui/bits.tsx";
import { Icon } from "../../ui/icons.tsx";
import { AdminView, RefreshButton, shownText, useAdminLoad, useAgain } from "./AdminPage.tsx";
import { CreditsOff, creditNum, DayChart, GrantForm, LedgerTable, resetsText, signed, tokenNum, usd } from "./credits-parts.tsx";

/** The search, kept across visits. */
const adminCreditsView = { q: "" };

export function AdminCredits() {
  useView("admin", "AI credits · Admin", "admin-credits");
  const loaded = useAdminLoad(() => api<API.AdminCredits>("/v1/admin/credits"));
  return (
    <AdminView loaded={loaded} title="AI credits" sub="Credit use across every account on this server" actions={() => <RefreshButton reload={loaded.reload} />}>
      {(d) => (d.enabled ? <Credits d={d} reload={loaded.reload} /> : <CreditsOff />)}
    </AdminView>
  );
}

function Credits({ d, reload }: { d: API.AdminCredits; reload: () => Promise<boolean> }) {
  const again = useAgain(reload);
  const fill = useRef<((email: string) => void) | null>(null);
  const [q, setQState] = useState(adminCreditsView.q);
  const setQ = (v: string) => setQState((adminCreditsView.q = v));
  const t = d.totals;
  const needle = q.trim().toLowerCase();
  const rows = d.accounts.filter((a) => !needle || [a.email, a.github].some((v) => v?.toLowerCase().includes(needle)));
  return (
    <>
      <div className="stats">
        <Stat label="Used this month" value={creditNum(t.used)} sub={`${usd(t.usd)} at list price · ${t.requests.toLocaleString()} request${t.requests === 1 ? "" : "s"}`} />
        <Stat label="From free credits" value={creditNum(t.free)} sub={d.monthlyCredits ? `${creditNum(d.monthlyCredits)} free per account a month · renews ${resetsText(d.resetsAt)}` : "No free credits on this server"} />
        <Stat label="Granted this month" value={signed(t.granted)} sub={`${t.grants} grant${t.grants === 1 ? "" : "s"} · ${creditNum(t.balance)} granted left${t.overdrawn ? ` · ${creditNum(t.overdrawn)} overdrawn` : ""}`} />
        <Stat label="Accounts" value={<>{String(t.active)}<small>{`of ${t.accounts}`}</small></>} sub="Used AI this month, of those with credits" />
      </div>
      <div className="detail-grid">
        <div className="stack">
          <div className="panel"><h2>Last 30 days</h2><DayChart days={d.days} /></div>
          <div className="panel">
            <h2>By model this month</h2>
            {d.models.length ? (
              <DataTable className="scroll-x" label="Models" heads={[["Model"], ["Requests", "num"], ["Tokens in / out", "num"], ["Cost", "num"], ["Credits", "num"]]}>
                {d.models.map((m) => (
                  <tr key={m.model}>
                    <td className="mono">{m.model}</td>
                    <td className="num">{m.requests.toLocaleString()}</td>
                    <td className="num">{`${tokenNum.format(m.inputTokens)} / ${tokenNum.format(m.outputTokens)}`}</td>
                    <td className="num">{usd(m.usd)}</td>
                    <td className="num">{creditNum(m.credits)}</td>
                  </tr>
                ))}
              </DataTable>
            ) : <p className="muted small">No AI use this month.</p>}
          </div>
        </div>
        <GrantForm emails={d.accounts.map((a) => a.email)} after={() => void again()} fill={fill} />
      </div>
      <div className="toolbar">
        <h2 className="toolbar-title">Accounts</h2>
        <div className="search">
          <Icon name="search" />
          <input type="search" className="input" placeholder="Search accounts" aria-label="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <p className="sr-only" role="status">{shownText(rows.length, "account")}</p>
      </div>
      <DataTable label="Accounts table" caption="Accounts with AI credits, most used this month first"
        heads={[["Account"], ["Available", "num"], ["Granted left", "num"], ["Free used", "num"], ["Used this month", "num"], ["Requests", "num"], ["Last used"], ["Actions", undefined, true]]}>
        {rows.length ? rows.map((a) => (
          <tr key={a.id}>
            <td>
              <Link to="/admin-credits/$id" params={{ id: a.id }}>{a.email}</Link>
              {a.github ? <span className="sub">{`@${a.github}`}</span> : null}
            </td>
            <td className={`num${a.available <= 0 ? " error" : ""}`}>{creditNum(Math.max(0, a.available))}</td>
            <td className="num">{creditNum(a.balance)}</td>
            <td className="num">{d.monthlyCredits ? `${creditNum(a.monthlyUsed)} / ${creditNum(d.monthlyCredits)}` : "—"}</td>
            <td className="num">{creditNum(a.used)}</td>
            <td className="num">{a.requests.toLocaleString()}</td>
            <td>{a.lastUsedAt ? <TimeAgo iso={a.lastUsedAt} /> : <span className="muted">never</span>}</td>
            <td className="actions">
              <button className="btn sm" type="button" aria-label={`Give credits to ${a.email}`} onClick={() => fill.current?.(a.email)}>Give</button>
            </td>
          </tr>
        )) : <tr><td colSpan={8} className="empty">{needle ? "No accounts match." : "No account has used or been given credits yet."}</td></tr>}
      </DataTable>
      <p className="muted small">Available: this month's free credits left plus granted credits left. Accounts appear here once they use AI credits or are given some.</p>
      <h2 className="section-title">Recent activity</h2>
      <LedgerTable rows={d.recent} account />
    </>
  );
}
