// An app's Database tab: its tables, the selected one a page at a time (with its schema), and read-only queries.
import { Link, useParams } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json } from "../../lib/api.ts";
import { refocus } from "../../lib/focus.ts";
import { fmtBytes, plural } from "../../lib/format.ts";
import { useAlive, useLoad } from "../../lib/hooks.ts";
import { EmptyState } from "../../ui/bits.tsx";
import { Icon } from "../../ui/icons.tsx";
import { appPath, TabError, useApp, useTabReload } from "./AppLayout.tsx";

const DB_PAGE = 50;
/** The page you were on, by app + table (for this page load). */
const pages: Record<string, number> = {};
const quoteIdent = (n: string) => `"${n.replace(/"/g, '""')}"`;
const query = <T,>(name: string, sql: string, params?: unknown[]) => api<T>(appPath(name, "/db/query"), json("POST", params ? { sql, params } : { sql }));

type Table = { name: string; count: number; schema?: string };

export function AppDatabase() {
  const { name } = useApp();
  const { table = "" } = useParams({ from: "/apps/$name/database/{-$table}" });
  const db = useLoad(() => api<API.DbTables>(appPath(name, "/db?limit=0")), [name], { keep: true });
  // Refresh: the tables, then the rows shown (Browse reloads with them).
  const reload = db.reload;
  useTabReload(reload);
  if (db.error) return <TabError error={db.error} />;
  if (!db.data) return <p className="muted">Loading…</p>;
  const tables: Table[] = Object.entries(db.data.tables).map(([n, t]) => ({ name: n, ...t }));
  if (!tables.length) return <EmptyState title="No database yet">It's made the first time the app's server uses env.db.</EmptyState>;
  const sel = tables.find((t) => t.name === table) ?? tables[0]!; // not empty (above)
  return (
    <div className="db-grid">
      <nav className="db-tables panel" aria-label="Tables">
        <h2>Tables</h2>
        <ul>
          {tables.map((t) => (
            <li key={t.name}>
              <Link to="/apps/$name/database/{-$table}" params={{ name, table: t.name }} activeOptions={{ exact: true }} activeProps={{}}
                aria-current={t === sel ? "page" : undefined}>
                <span className="mono">{t.name}</span><span className="muted">{t.count.toLocaleString()}</span>
              </Link>
            </li>
          ))}
        </ul>
        {db.data.truncated ? <p className="muted small">Some tables aren't listed (too many).</p> : null}
      </nav>
      <div className="stack">
        <Browse key={sel.name} sel={sel} tables={db.data} />
        <Query key={`q\n${sel.name}`} sel={sel} />
      </div>
    </div>
  );
}

/** A cell's value: NULL, a blob's size, or the text (long text cut, the whole value in its title). */
function CellValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="null">NULL</span>;
  if (typeof v === "object" && typeof (v as { $bytes?: unknown }).$bytes === "string") {
    const b64 = (v as { $bytes: string }).$bytes;
    return <span className="null">{`BLOB ${fmtBytes(Math.floor((b64.length * 3) / 4) - (b64.match(/=*$/)![0].length))}`}</span>; // /=*$/ always matches
  }
  const s: string = typeof v === "string" ? v : JSON.stringify(v); // a JSON value from the API
  return s.length > 120 ? <span title={s.slice(0, 4000)}>{`${s.slice(0, 120)}…`}</span> : <>{s}</>;
}

/** A column from pragma_table_info, or just a name. */
type Column = string | { name: string; type?: string; pk?: number };
const colName = (c: Column) => (typeof c === "string" ? c : c.name);
function ResultTable({ rows, label, columns = null }: { rows: API.DbRows["rows"]; label: string; columns?: Column[] | null }) {
  const cols: Column[] = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (!cols.length) return <p className="muted small">No rows.</p>;
  return (
    <div className="table-wrap result" tabIndex={0} role="region" aria-label={label}>
      <table className="table data">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} scope="col" className={/INT|REAL|FLOA|DOUB|NUM|DEC/i.test(typeof c === "string" ? "" : c.type ?? "") ? "num" : ""}>
                {colName(c)}
                {typeof c === "object" && (c.pk || c.type) ? <span className="col-type">{[c.pk ? "PK" : null, c.type].filter(Boolean).join(" ")}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c, j) => {
                const v = r[colName(c)];
                return <td key={j} className={typeof v === "number" ? "num" : ""}><CellValue v={v} /></td>;
              })}
            </tr>
          )) : <tr><td colSpan={cols.length} className="empty">No rows.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** The selected table, a page at a time. */
function Browse({ sel, tables }: { sel: Table; tables: API.DbTables }) {
  const { name } = useApp();
  const key = `${name}\n${sel.name}`;
  const [offset, setOffset] = useState(() => pages[key] ?? 0);
  /** The pager button pressed, until its page is in. */
  const moved = useRef<"db-prev" | "db-next" | null>(null);
  // The columns once per table (Refresh reads them again: `tables`), then each page. One query at a time: the server
  // runs at most two per app at once.
  const cols = useRef<{ of: API.DbTables; cols: Promise<Column[]> } | null>(null);
  const load = useCallback(async () => {
    if (cols.current?.of !== tables) {
      const p = query<{ rows: { name: string; type: string; pk: number }[] }>(name, "SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid", [sel.name]).then((x) => x.rows);
      cols.current = { of: tables, cols: p };
      p.catch(() => cols.current?.cols === p && (cols.current = null)); // a failed read is tried again
    }
    const c = await cols.current.cols;
    const r = await query<API.DbRows>(name, `SELECT * FROM ${quoteIdent(sel.name)} LIMIT ? OFFSET ?`, [DB_PAGE, offset]);
    return { cols: c, rows: r.rows, offset };
  }, [name, sel.name, offset, tables]);
  const page = useLoad(load, [load], { keep: true });
  useEffect(() => {
    const from = moved.current;
    if (!page.data || !from) return;
    moved.current = null;
    // The first or last page: its button is disabled now, so the other one takes focus.
    const b = document.getElementById(from) as HTMLButtonElement | null;
    if (b?.disabled && (document.activeElement === b || document.activeElement === document.body)) document.getElementById(from === "db-next" ? "db-prev" : "db-next")?.focus();
    else refocus();
  }, [page.data]);
  const go = (to: number, from: "db-prev" | "db-next") => {
    pages[key] = to;
    moved.current = from;
    setOffset(to);
  };

  const p = page.error ? undefined : page.data; // a failed page: no pager (Refresh retries), as before useLoad kept data
  const last = p ? Math.min(p.offset + p.rows.length, sel.count) : 0;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="mono">{sel.name}</h2>
        <span className="muted small">{plural(sel.count, "row")}</span>
      </div>
      {sel.schema ? <details className="schema"><summary>Schema</summary><pre className="mono">{sel.schema}</pre></details> : null}
      <div>
        {page.error ? <p className="error small">{`Could not read ${sel.name}: ${page.error.message}`}</p>
          : p ? <ResultTable rows={p.rows} label={`${sel.name} rows`} columns={p.cols.length ? p.cols : null} />
          : <p className="muted small">Loading rows…</p>}
      </div>
      <div className="row start pager">
        <span className="muted small" role="status">
          {p ? (sel.count ? `Rows ${(p.offset + 1).toLocaleString()}–${last.toLocaleString()} of ${sel.count.toLocaleString()}` : "No rows") : ""}
        </span>
        {p ? (
          <>
            <button className="btn sm" type="button" id="db-prev" disabled={p.offset === 0} onClick={() => go(Math.max(0, p.offset - DB_PAGE), "db-prev")}>Previous</button>
            <button className="btn sm" type="button" id="db-next" disabled={p.offset + DB_PAGE >= sel.count} onClick={() => go(p.offset + DB_PAGE, "db-next")}>Next</button>
          </>
        ) : null}
      </div>
    </div>
  );
}

type Out = { running: true } | { rows: API.DbRows; ms: number } | { error: string } | null;

/** Any read-only SQL. */
function Query({ sel }: { sel: Table }) {
  const { name } = useApp();
  const alive = useAlive();
  const [sql, setSql] = useState(`SELECT * FROM ${quoteIdent(sel.name)} LIMIT 100`);
  const [out, setOut] = useState<Out>(null);
  const form = useRef<HTMLFormElement>(null);
  const running = !!out && "running" in out;

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!sql.trim() || running) return;
    const started = performance.now();
    setOut({ running: true });
    try {
      const r = await query<API.DbRows>(name, sql);
      if (alive.current) setOut({ rows: r, ms: Math.round(performance.now() - started) });
    } catch (err) {
      if (alive.current) setOut({ error: errorMessage(err) });
    }
  }

  return (
    <div className="panel">
      <h2>Query</h2>
      <form className="query" ref={form} onSubmit={(e) => void run(e)}>
        <textarea className="input mono sql" id="db-sql" rows={4} spellCheck={false} aria-label="SQL" value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              form.current?.requestSubmit();
            }
          }} />
        <div className="row start">
          <button className="btn primary" type="submit" disabled={running}><Icon name="zap" />Run</button>
          <span className="muted small">Read only · ⌘/Ctrl + Enter runs it · at most 1,000 rows, 5 seconds</span>
        </div>
      </form>
      <div className="query-out" role="status">
        {!out ? null
          : "running" in out ? <p className="muted small">Running…</p>
          : "error" in out ? <p className="error small">{out.error}</p>
          : (
            <>
              <p className="muted small">{`${plural(out.rows.rows.length, "row")}${out.rows.truncated ? " (cut off: at most 1,000 rows or 4 MB)" : ""} in ${out.ms} ms`}</p>
              {out.rows.rows.length ? <ResultTable rows={out.rows.rows} label="Query result" /> : null}
            </>
          )}
      </div>
    </div>
  );
}
