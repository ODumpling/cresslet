// The workspace's Database view: the preview's database (the one `cresslet dev` serves the app with, kept in
// .cresslet/dev/db.sqlite): its tables, and any SQL run on it (reads and writes), as the app's own queries are.
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { SqlCell, SqlResult } from "../../../server-worker-protocol.ts";
import { errorMessage } from "../../lib/api.ts";
import { fmtBytes, plural } from "../../lib/format.ts";
import { useAlive } from "../../lib/hooks.ts";
import { Icon } from "../../ui/icons.tsx";

export type RunSql = (sql: string) => Promise<SqlResult>;

const quoteIdent = (n: string) => `"${n.replace(/"/g, '""')}"`;
const quoteText = (s: string) => `'${s.replace(/'/g, "''")}'`;
type Table = { name: string; view: boolean; count: number | null };
type Out = { running: true } | { result: SqlResult; ms: number } | { error: string } | null;

/** The tables and views, each table with its row count (one script: the server worker runs it at once). */
async function listTables(run: RunSql): Promise<Table[]> {
  const r = await run("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
  const all = r.rows.map(([name, type]) => ({ name: String(name), view: type === "view", count: null as number | null }));
  const tables = all.filter((t) => !t.view);
  if (tables.length) {
    const counts = await run(tables.map((t) => `SELECT ${quoteText(t.name)}, count(*) FROM ${quoteIdent(t.name)}`).join(" UNION ALL "));
    const by = new Map(counts.rows.map(([n, c]) => [String(n), Number(c)]));
    for (const t of tables) t.count = by.get(t.name) ?? null;
  }
  return all;
}

/** `run`: null until the project's container is up. `shown`: the view is on screen (it reads the tables then). */
export function DatabaseView({ run, shown }: { run: RunSql | null; shown: boolean }) {
  const alive = useAlive();
  const [tables, setTables] = useState<{ list: Table[] } | { error: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sql, setSql] = useState("");
  const [out, setOut] = useState<Out>(null);
  const form = useRef<HTMLFormElement>(null);
  const running = !!out && "running" in out;

  const refresh = useCallback(async () => {
    if (!run) return;
    try {
      const list = await listTables(run);
      if (alive.current) setTables({ list });
    } catch (e) {
      if (alive.current) setTables({ error: errorMessage(e) });
    }
  }, [run, alive]);
  useEffect(() => {
    if (shown) void refresh();
  }, [shown, refresh]);

  async function exec(script: string) {
    if (!run || !script.trim() || running) return;
    const started = performance.now();
    setOut({ running: true });
    try {
      const result = await run(script);
      if (alive.current) setOut({ result, ms: Math.round(performance.now() - started) });
    } catch (e) {
      if (alive.current) setOut({ error: errorMessage(e) });
    }
    void refresh(); // tables made, dropped, filled or emptied
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void exec(sql);
  }
  function browse(name: string) {
    const q = `SELECT * FROM ${quoteIdent(name)} LIMIT 100;`;
    setSelected(name);
    setSql(q);
    void exec(q);
  }

  const list = tables && "list" in tables ? tables.list : null;
  return (
    <>
      <section className="pane files db-tables-pane" id="db-tables-pane" aria-labelledby="db-tables-title" hidden={!shown}>
        <div className="pane-head">
          <h2 id="db-tables-title" className="pane-title">Tables</h2>
          <button className="icon-btn" id="db-refresh" type="button" aria-label="Refresh tables" title="Refresh tables" disabled={!run} onClick={() => void refresh()}>
            <Icon name="refresh" />
          </button>
        </div>
        <nav className="tree" aria-labelledby="db-tables-title">
          {!run ? <p className="muted small db-note">The database opens once the project runs (its dev server serves it).</p>
            : !tables ? <p className="muted small db-note">Loading…</p>
            : "error" in tables ? <p className="error small db-note" id="db-tables-error">{tables.error}</p>
            : !tables.list.length ? <p className="muted small db-note">No tables yet. The app makes them the first time its server uses <code>env.db</code>, or create one here.</p>
            : (
              <ul>
                {tables.list.map((t) => (
                  <li key={t.name}>
                    <button type="button" data-table={t.name} aria-current={t.name === selected ? "true" : undefined} onClick={() => browse(t.name)}>
                      <Icon name={t.view ? "search" : "database"} /><span className="mono db-name">{t.name}</span>
                      <span className="muted db-count">{t.view ? "view" : t.count === null ? "" : t.count.toLocaleString()}</span>
                      <SrRows t={t} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </nav>
      </section>
      <section className="pane db-pane" id="db-pane" aria-labelledby="db-title" hidden={!shown}>
        <div className="pane-head">
          <Icon name="database" />
          <h2 id="db-title" className="pane-title crumb">Preview database</h2>
        </div>
        <form className="db-query" ref={form} onSubmit={submit}>
          <textarea className="input mono sql" id="db-sql" rows={5} spellCheck={false} aria-label="SQL" aria-describedby="db-help"
            placeholder={list?.length ? `SELECT * FROM ${quoteIdent(list[0]!.name)} LIMIT 100;` : "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);"} // non-empty
            value={sql} onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                form.current?.requestSubmit();
              }
            }} />
          <div className="row start">
            <button className="btn primary sm" type="submit" id="db-run" disabled={!run || running || !sql.trim()}><Icon name="zap" />Run</button>
            <span className="muted small" id="db-help">⌘/Ctrl + Enter runs it · reads and writes · several statements run in order; the last result shows</span>
          </div>
        </form>
        <div className="db-out" role="status">
          {!out ? null
            : "running" in out ? <p className="muted small">Running…</p>
            : "error" in out ? <p className="error small" id="db-error">{out.error}</p>
            : <Summary result={out.result} ms={out.ms} />}
        </div>
        {out && "result" in out && out.result.columns.length ? <Grid result={out.result} /> : null}
        <p className="pane-foot">The preview's own database (<code>.cresslet/dev/db.sqlite</code>), not the deployed app's.</p>
      </section>
    </>
  );
}

function SrRows({ t }: { t: Table }) {
  if (t.view || t.count === null) return null;
  return <span className="sr-only">{`, ${plural(t.count, "row")}`}</span>;
}

function Summary({ result: r, ms }: { result: SqlResult; ms: number }) {
  const parts = [];
  if (r.columns.length) parts.push(`${plural(r.rows.length, "row")}${r.truncated ? " (the first 1,000)" : ""}`);
  if (r.changes || !r.columns.length) parts.push(`${plural(r.changes, "row")} changed`);
  if (r.statements > 1) parts.push(`${r.statements} statements`);
  return <p className="muted small" id="db-summary">{`${parts.join(" · ")} in ${ms} ms`}</p>;
}

function Cell({ v }: { v: SqlCell }) {
  if (v === null) return <span className="null">NULL</span>;
  if (typeof v === "object") return <span className="null">{`BLOB ${fmtBytes(v.blob)}`}</span>;
  const s = String(v);
  return s.length > 120 ? <span title={s.slice(0, 4000)}>{`${s.slice(0, 120)}…`}</span> : <>{s}</>;
}

/** A column of numbers (NULLs aside): right-aligned, as its cells are. */
const numeric = (r: SqlResult, i: number) => r.rows.some((row) => typeof row[i] === "number") && r.rows.every((row) => row[i] === null || typeof row[i] === "number");

function Grid({ result: r }: { result: SqlResult }) {
  return (
    <div className="table-wrap result db-result" tabIndex={0} role="region" aria-label="Query result">
      <table className="table data">
        <thead>
          <tr>{r.columns.map((c, i) => <th key={i} scope="col" className={numeric(r, i) ? "num" : ""}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {r.rows.length ? r.rows.map((row, i) => (
            <tr key={i}>{row.map((v, j) => <td key={j} className={typeof v === "number" ? "num" : ""}><Cell v={v} /></td>)}</tr>
          )) : <tr><td colSpan={r.columns.length} className="empty">No rows.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
