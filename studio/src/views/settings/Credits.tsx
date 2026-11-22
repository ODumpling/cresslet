// /settings/credits (when the server offers AI credits): what's left, this month's free credits, and the history,
// a page at a time.
import { useEffect, useRef, useState } from "react";
import type * as API from "../../../api-types.ts";
import { api, meta } from "../../lib/api.ts";
import { refocus } from "../../lib/focus.ts";
import { Icon } from "../../ui/icons.tsx";
import { when } from "../../lib/format.ts";
import { useLoad, useView } from "../../lib/hooks.ts";

const PAGE = 10;

export function SettingsCredits() {
  useView("settings", "AI credits · Settings");
  // Pages count from the newest entry the first load had (upTo), so use added meanwhile doesn't shift them (Newer
  // and Older always go to the adjacent page); opening the tab again shows the latest.
  const [want, setWant] = useState<{ offset: number; upTo: number | null }>({ offset: 0, upTo: null });
  /** The pager button pressed, until its page is in. */
  const moved = useRef<"credits-prev" | "credits-next" | null>(null);
  // The page shown keeps its own offset: the previous one stays shown (and counted) while the next loads.
  const c = useLoad(async () => ({
    at: want.offset,
    r: (await meta()).ai?.credits
      ? await api<API.MyCredits>(`/v1/me/credits?offset=${want.offset}&limit=${PAGE}${want.upTo === null ? "" : `&upTo=${want.upTo}`}`)
      : null,
  }), [want], { keep: true });
  // (keep: the last page that loaded stays shown, with the pager, when another fails to.)
  const shown = c.data;
  useEffect(() => {
    const from = moved.current;
    if (!c.data || !from) return;
    moved.current = null;
    // The first or last page: its button is disabled now, so the other one takes focus.
    const b = document.getElementById(from) as HTMLButtonElement | null;
    if (b?.disabled && (document.activeElement === b || document.activeElement === document.body)) document.getElementById(from === "credits-next" ? "credits-prev" : "credits-next")?.focus();
    else refocus();
  }, [c.data]);
  const go = (offset: number, upTo: number, from: "credits-prev" | "credits-next") => {
    moved.current = from;
    setWant({ offset, upTo });
  };

  const r = shown?.r;
  const num = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const tokens = new Intl.NumberFormat();
  const amount = (x: number) => `${num.format(x)} ${num.format(x) === "1" ? "credit" : "credits"}`;
  if (shown && !r?.enabled && !c.error) {
    return (
      <section className="block" aria-labelledby="credits-title">
        <div className="block-head"><h2 id="credits-title">AI credits</h2></div>
        <p className="muted" id="credits-off">AI credits aren't on for this server.</p>
      </section>
    );
  }
  const at = shown?.at ?? 0;
  return (
    <section className="block" id="credits-section" aria-labelledby="credits-title">
      <div className="block-head">
        <h2 id="credits-title">AI credits</h2>
        <p className="muted small" id="credits-hint">The AI builder spends credits on what Claude reads and writes. This month's free credits go first.</p>
      </div>
      <dl className="panel kv credits-kv">
        <dt>Available</dt><dd id="credits-available">{r?.enabled ? amount(Math.max(0, r.available)) : "—"}</dd>
        <dt>Free this month</dt><dd id="credits-monthly">{!r?.enabled ? "—" : r.monthly.allowance
          ? `${num.format(r.monthly.remaining)} of ${num.format(r.monthly.allowance)} left, renews ${new Date(r.monthly.resetsAt).toLocaleDateString()}`
          : "None on this server"}</dd>
        <dt>Granted</dt><dd id="credits-balance">{r?.enabled ? `${amount(r.balance)}${r.balance < 0 ? " (the last request went over)" : ""}` : "—"}</dd>
      </dl>
      <h3 className="sub-title" id="credits-history-title">History</h3>
      <ul className="list" id="credits-history" aria-labelledby="credits-history-title" aria-busy={c.loading}>
        {!r?.enabled ? null
          : !r.history.length ? <li className="list-row muted">{at ? "No more entries." : "No AI credits used yet."}</li>
          : r.history.map((h, i) => (
            <li className="list-row" key={at + i}>
              <div className="tok">
                <strong>{h.kind === "usage" ? `AI builder (${h.model ?? "Claude"})` : h.credits > 0 ? "Credits added" : "Credits removed"}</strong>
                <span className="meta">{h.kind === "usage"
                  ? `${tokens.format(h.inputTokens + h.cacheReadTokens + h.cacheWriteTokens)} tokens in, ${tokens.format(h.outputTokens)} out${h.estimated ? " (estimated: the reply was cut off)" : ""}`
                  : h.note ?? "by the operator"}</span>
              </div>
              <span className="meta">{when(h.at)}</span>
              <span className="credit-delta">{`${h.credits > 0 ? "+" : "−"}${num.format(Math.abs(h.credits))}`}</span>
            </li>
          ))}
      </ul>
      {c.error ? (
        <div className="row start pager" role="alert">
          <p className="error small">Could not load AI credits: {c.error.message}</p>
          <button className="btn sm" type="button" id="credits-retry" onClick={() => void c.reload().then((ok) => ok && refocus())}><Icon name="refresh" />Retry</button>
        </div>
      ) : null}
      {r?.enabled && (r.historyTotal > PAGE || at > 0) ? (
        <div className="row start pager" id="credits-pager">
          <span className="muted small" role="status">
            {r.history.length ? `Entries ${(at + 1).toLocaleString()}–${(at + r.history.length).toLocaleString()} of ${r.historyTotal.toLocaleString()}` : ""}
          </span>
          <button className="btn sm" type="button" id="credits-prev" disabled={at === 0} onClick={() => !c.loading && go(Math.max(0, at - PAGE), r.historyUpTo, "credits-prev")}>Newer</button>
          <button className="btn sm" type="button" id="credits-next" disabled={at + PAGE >= r.historyTotal} onClick={() => !c.loading && go(at + PAGE, r.historyUpTo, "credits-next")}>Older</button>
        </div>
      ) : null}
    </section>
  );
}
