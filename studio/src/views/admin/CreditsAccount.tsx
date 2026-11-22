// /admin-credits/<account id> (site admins): one account's AI credits: its ledger, and giving or taking back credits.
import { Link, useParams } from "@tanstack/react-router";
import type * as API from "../../../api-types.ts";
import { api } from "../../lib/api.ts";
import { ago } from "../../lib/format.ts";
import { useView } from "../../lib/hooks.ts";
import { Stat } from "../../ui/bits.tsx";
import { AdminView, RefreshButton, useAdminLoad, useAgain } from "./AdminPage.tsx";
import { CreditsOff, creditNum, GrantForm, LedgerTable, resetsText } from "./credits-parts.tsx";

export function AdminCreditsAccount() {
  const { id } = useParams({ from: "/admin-credits/$id" });
  const loaded = useAdminLoad(() => api<API.AdminCreditsAccount>(`/v1/admin/credits/accounts/${encodeURIComponent(id)}`), [id]);
  const again = useAgain(loaded.reload);
  const d = loaded.data;
  const a = d?.enabled ? d.account : null;
  useView("admin", a ? `${a.email} · AI credits · Admin` : "AI credits · Admin", "admin-credits");
  return (
    <AdminView
      loaded={loaded}
      title={loaded.error || (d && !d.enabled) ? "AI credits" : <><Link to="/admin-credits">AI credits</Link>{" / "}{a ? a.email : "…"}</>}
      sub={a ? [a.github && `@${a.github}`, a.siteAdmin && "Site admin"].filter(Boolean).join(" · ") || "Account" : ""}
      retryFocus="heading"
      actions={() => <RefreshButton reload={loaded.reload} />}
    >
      {(d) => (d.enabled ? (
        <>
          <div className="stats">
            <Stat label="Available" value={creditNum(Math.max(0, d.account.available))} sub={d.account.available <= 0 ? "Out of credits: AI requests are refused" : "Free credits left plus granted credits"} />
            <Stat label="Granted left" value={creditNum(d.account.balance)} sub={d.account.balance < 0 ? "Overdrawn" : "Doesn't expire"} />
            <Stat label="Free this month" value={<>{creditNum(Math.max(0, d.monthlyCredits - d.account.monthlyUsed))}<small>{`of ${creditNum(d.monthlyCredits)}`}</small></>} sub={`Renews ${resetsText(d.resetsAt)}`} />
            <Stat label="Used this month" value={creditNum(d.account.used)} sub={`${d.account.requests.toLocaleString()} request${d.account.requests === 1 ? "" : "s"} · last ${d.account.lastUsedAt ? ago(d.account.lastUsedAt) : "never"}`} />
          </div>
          <div className="detail-grid">
            <div className="stack">
              <h2 className="section-title flush">Activity</h2>
              <LedgerTable rows={d.history} />
              {d.history.length === 200 ? <p className="muted small">The latest 200 entries.</p> : null}
            </div>
            <GrantForm email={d.account.email} after={() => void again()} />
          </div>
        </>
      ) : <CreditsOff />)}
    </AdminView>
  );
}
