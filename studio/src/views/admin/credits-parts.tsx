// What the AI credits pages share: number formats, the grant form, the per-day chart, the ledger.
import { Link } from "@tanstack/react-router";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json, statusOf } from "../../lib/api.ts";
import { useAlive } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";
import { DataTable, EmptyState, Field, FormError, TimeAgo } from "../../ui/bits.tsx";
import { Icon } from "../../ui/icons.tsx";

export const creditNum = (x: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(x); // millicredits: exact
export const creditsText = (x: number) => `${creditNum(x)} ${creditNum(x) === "1" ? "credit" : "credits"}`;
export const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${creditNum(Math.abs(x))}`;
export const usd = (x: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: x && Math.abs(x) < 1 ? 4 : 2 }).format(x);
export const tokenNum = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const resetsText = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const ledgerWhat = (h: API.LedgerEntry): [string, string] => h.kind === "usage"
  ? [h.model ?? "Claude",
    `${tokenNum.format(h.inputTokens + h.cacheReadTokens + h.cacheWriteTokens)} in · ${tokenNum.format(h.outputTokens)} out${h.usd != null ? ` · ${usd(h.usd)}` : ""}${h.free ? ` · ${creditNum(h.free)} free` : ""}${h.estimated ? " · estimated (cut off)" : ""}`]
  : [h.credits > 0 ? "Credits given" : "Credits taken back", [h.by && `by ${h.by}`, h.note].filter(Boolean).join(": ") || "by the operator"];

/** A grant from before a Refresh (or on another credits page) is still being sent. */
let grantBusy = false;

/**
 * Give (or, negative, take back) credits. `email` fixed: for one account's page; else typed, with `emails` suggested,
 * and `fill` set to a function that puts an email in (and focuses the credits).
 */
export function GrantForm({ email = null, emails = [], after, fill }: {
  email?: string | null;
  emails?: string[];
  after: () => unknown;
  fill?: RefObject<((email: string) => void) | null>;
}) {
  const alive = useAlive();
  const formRef = useRef<HTMLFormElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!fill) return;
    fill.current = (e) => {
      flushSync(() => setTo(e));
      amountRef.current?.focus();
      formRef.current?.scrollIntoView({ block: "nearest" });
    };
    return () => void (fill.current = null);
  }, [fill]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const who = email ?? to.trim();
    const credits = Math.round(Number(amount) * 1000) / 1000; // the server keeps millicredits
    setErr("");
    if (!who) return void toRef.current?.focus();
    if (grantBusy) return setErr("A grant is still being sent. Try again in a moment.");
    if (!Number.isFinite(credits) || credits === 0) {
      setErr("Enter a number of credits other than 0 (at most 3 decimal places).");
      return void amountRef.current?.focus();
    }
    if (credits < 0 && !confirm(`Take ${creditsText(-credits)} back from ${who}?`)) return;
    setBusy(true);
    grantBusy = true;
    try {
      const r = await api<{ account: { email: string }; balance: number }>("/v1/admin/accounts/credits", json("POST", { email: who, credits, ...(note.trim() ? { note: note.trim() } : {}) }));
      toast(`${credits > 0 ? "Gave" : "Took back"} ${creditsText(Math.abs(credits))} ${credits > 0 ? "to" : "from"} ${r.account.email}. Granted balance: ${creditNum(r.balance)}.`);
      if (!alive.current) return;
      flushSync(() => { // a fresh form, as before the grant
        setTo("");
        setAmount("");
        setNote("");
        setBusy(false);
      });
      after();
    } catch (x) {
      if (!alive.current) return; // navigated away meanwhile
      flushSync(() => {
        setErr(statusOf(x) === 404 ? `No account with the email ${who}.` : `Could not give credits: ${errorMessage(x)}`);
        setBusy(false);
      });
      (statusOf(x) === 404 && !email ? toRef : amountRef).current?.focus();
    } finally {
      grantBusy = false;
    }
  }

  return (
    <form ref={formRef} className="panel form grant-form" aria-label={email ? `Give credits to ${email}` : "Give credits"} onInput={() => setErr("")} onSubmit={(e) => void submit(e)}>
      <h2>{email ? "Give credits" : "Give credits to an account"}</h2>
      {email ? null : (
        <Field label="Account email" htmlFor="grant-email">
          <input ref={toRef} className="input" id="grant-email" type="email" required autoComplete="off" spellCheck={false} placeholder="name@example.com"
            list="grant-emails" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      )}
      {email ? null : <datalist id="grant-emails">{emails.map((e) => <option key={e} value={e} />)}</datalist>}
      <Field label="Credits" htmlFor="grant-credits" hint="A negative number takes credits back.">
        <input ref={amountRef} className="input" id="grant-credits" type="number" required step="any" placeholder="100" aria-describedby="grant-credits-hint"
          value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Note (optional)" htmlFor="grant-note">
        <input className="input" id="grant-note" maxLength={200} autoComplete="off" placeholder="Beta tester" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <FormError text={err} />
      <div className="row start">
        <button className="btn primary" type="submit" disabled={busy}><Icon name="plus" />Give credits</button>
      </div>
    </form>
  );
}

/** Credits used per day: bars, named by a summary (and each bar's own title), and a table of the days with use. */
export function DayChart({ days }: { days: API.AdminCredits["days"] }) {
  const max = Math.max(...days.map((d) => d.credits));
  const total = days.reduce((n, d) => n + d.credits, 0);
  const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const peak = days.reduce((a, d) => (d.credits > a.credits ? d : a), days[0]!); // 30 days
  const label = max
    ? `Credits used per day, ${fmt(days[0]!.date)} to ${fmt(days.at(-1)!.date)}: ${creditsText(total)} in all, most on ${fmt(peak.date)} (${creditNum(peak.credits)})`
    : "No credits used in the last 30 days";
  return (
    <div>
      <div className="day-chart" role="img" aria-label={label}>
        {days.map((d) => (
          <span key={d.date} title={`${fmt(d.date)}: ${creditsText(d.credits)}, ${d.requests} request${d.requests === 1 ? "" : "s"}`}
            style={{ height: max ? `${Math.max(d.credits ? 3 : 0, (d.credits / max) * 100)}%` : "0" }} />
        ))}
      </div>
      <div className="day-axis" aria-hidden="true">
        <span>{fmt(days[0]!.date)}</span><span>{max ? `peak ${creditNum(max)}` : ""}</span><span>Today</span>
      </div>
      {/* Each day's numbers, for keyboards, touch and screen readers (the bars' titles need a pointer). */}
      {max ? (
        <details className="day-table">
          <summary>Days with use</summary>
          <table className="table">
            <thead><tr>{["Day", "Credits", "Requests"].map((h, i) => <th key={h} scope="col" className={i ? "num" : ""}>{h}</th>)}</tr></thead>
            <tbody>
              {days.filter((d) => d.requests).reverse().map((d) => (
                <tr key={d.date}>
                  <td>{fmt(d.date)}</td>
                  <td className="num">{creditNum(d.credits)}</td>
                  <td className="num">{d.requests.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

/** Credit activity, newest first; `account`: with an Account column (across accounts). */
export function LedgerTable({ rows, account = false }: { rows: API.LedgerEntry[]; account?: boolean }) {
  return (
    <DataTable label="Credit activity" caption="Credit activity, newest first"
      heads={[["When"], ...(account ? [["Account"] as [string]] : []), ["Activity"], ["Credits", "num"]]}>
      {rows.length ? rows.map((h, i) => {
        const [what, sub] = ledgerWhat(h);
        return (
          <tr key={i}>
            <td><TimeAgo iso={h.at} /></td>
            {account ? <td><Link to="/admin-credits/$id" params={{ id: h.account.id }}>{h.account.email}</Link></td> : null}
            <td className="wrap"><span>{what}</span><span className="sub">{sub}</span></td>
            <td className={`num credit-delta${h.credits > 0 ? " plus" : ""}`}>{signed(h.credits)}</td>
          </tr>
        );
      }) : <tr><td colSpan={account ? 4 : 3} className="empty">No credit activity yet.</td></tr>}
    </DataTable>
  );
}

export const CreditsOff = () => (
  <EmptyState title="AI credits are off on this server">
    Set CRESSLET_ANTHROPIC_API_KEY to let accounts use the AI builder on the server's key, metered in credits.
  </EmptyState>
);
