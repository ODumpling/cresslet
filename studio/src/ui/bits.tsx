// Small pieces the views share.
import type { ReactNode } from "react";
import type * as API from "../../api-types.ts";
import { ago, fmtBytes, STATUS } from "../lib/format.ts";
import { SrOnly } from "./icons.tsx";

export const TimeAgo = ({ iso }: { iso: string | number }) => (
  <time dateTime={new Date(iso).toISOString()} title={new Date(iso).toLocaleString()}>{ago(iso)}</time>
);

export const StatusPill = ({ s, text = STATUS[s] ?? s }: { s: string; text?: string }) => (
  <span className="pill" data-s={s}><i className="dot" aria-hidden="true" />{text}</span>
);

export const Stat = ({ label, value, sub, extra }: { label: string; value: ReactNode; sub: string; extra?: ReactNode }) => (
  <div className="stat">
    <div className="label">{label}</div>
    <div className="value">{extra}{value}</div>
    <div className="sub">{sub}</div>
  </div>
);

export function UsageBar({ u }: { u: API.Usage }) {
  const parts = [["deploys", "Site"], ["database", "Database"], ["files", "Files"]] as const;
  const total = u.total || 1;
  return (
    <div>
      <div className="usage-bar" role="img" aria-label={parts.map(([k, l]) => `${l} ${fmtBytes(u[k])}`).join(", ")}>
        {parts.filter(([k]) => u[k] > 0).map(([k]) => <span key={k} className={`seg-${k}`} style={{ flex: String(u[k] / total) }} />)}
      </div>
      <div className="legend">
        {parts.map(([k, l]) => <span key={k}><i className={`seg-${k}`} />{l} {fmtBytes(u[k])}</span>)}
      </div>
    </div>
  );
}

export const EmptyState = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="empty-state"><strong>{title}</strong><span>{children}</span></div>
);

/** A form's error, beside it (not a timed toast) until the user changes the form. */
export const FormError = ({ id, text }: { id?: string; text: string }) => (
  <p className="error small" id={id} role="alert" hidden={!text}>{text}</p>
);

/** A labelled field; `hint` gets the id `<input id>-hint`. */
export const Field = ({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) => (
  <div className="field">
    <label htmlFor={htmlFor}>{label}</label>
    {children}
    {hint ? <p className="muted small" id={`${htmlFor}-hint`}>{hint}</p> : null}
  </div>
);

/** A table that scrolls sideways, focusable so a keyboard can scroll it; `heads`: [text, class?, visually hidden?]. */
export function DataTable({ label, labelledBy, heads, children, className = "table-wrap", caption }: {
  label: string;
  labelledBy?: string;
  heads: [string, string?, boolean?][];
  children: ReactNode;
  className?: string;
  caption?: string;
}) {
  return (
    <div className={className} tabIndex={0} role="region" aria-label={label}>
      <table className="table" aria-labelledby={labelledBy}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead><tr>{heads.map(([h, cls, hide], i) => <th key={i} scope="col" className={cls ?? ""}>{hide ? <SrOnly>{h}</SrOnly> : h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A Show filter (aria-pressed buttons). */
export function Seg<K extends string>({ options, value, onChange, idPrefix }: { options: [K, string][]; value: K; onChange: (k: K) => void; idPrefix?: string }) {
  return (
    <div className="seg" role="group" aria-label="Show">
      {options.map(([k, l]) => (
        <button key={k} type="button" id={idPrefix ? `${idPrefix}${k}` : undefined} aria-pressed={k === value} data-k={k} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  );
}
