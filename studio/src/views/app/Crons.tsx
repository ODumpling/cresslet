// An app's Crons tab: each cron its deploy declares (cresslet.json `crons`), when it runs next, how its last run went,
// and the runs since the server started. Owners and admins pause, resume and run one now.
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json } from "../../lib/api.ts";
import { refocusId } from "../../lib/focus.ts";
import { ago, canManage, plural } from "../../lib/format.ts";
import { useAlive, useLoad } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";
import { DataTable, EmptyState, StatusPill, TimeAgo } from "../../ui/bits.tsx";
import { Icon } from "../../ui/icons.tsx";
import { envPath, TabError, useApp, useTabReload } from "./AppLayout.tsx";

/** How often the tab looks again (while it's visible): a run queued or running, or else (scheduled runs, next times). */
const BUSY_POLL_MS = 2000;
const IDLE_POLL_MS = 30_000;

export function AppCrons() {
  const { name, env, d } = useApp();
  const config = env === "production" ? d.app.config : d.environments?.find((e) => e.name === env)?.config;
  const server = !!config?.server;
  const c = useLoad(() => (server ? api<API.Crons>(envPath(name, env, "/crons")) : Promise.resolve(null)), [name, env, server], { keep: true });
  useTabReload(c.reload);
  const reload = c.reload;

  if (!server) {
    return <EmptyState title="No crons">Crons call a server's <code>scheduled()</code> export. This app is a static site: add a server to use them.</EmptyState>;
  }
  if (c.data) return <Body v={c.data} onChange={reload} />;
  if (c.error) return <TabError error={c.error} />;
  return <p className="muted">Loading…</p>;
}

const result = (r: API.CronRun) => (r.ok ? "OK" : r.status ? `Failed (${r.status})` : "Failed (no response)");
const RunPill = ({ r }: { r: API.CronRun }) => <StatusPill s={r.ok ? "live" : "deleted"} text={result(r)} />;
const at = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Body({ v: loaded, onChange }: { v: API.Crons; onChange: () => Promise<boolean> }) {
  const { name, env, d } = useApp();
  const alive = useAlive();
  const a = d.app, manage = canManage(a.access) && a.claimed;
  // What the last action answered, until the next load.
  const [v, setV] = useState(loaded);
  const [shown, setShown] = useState(loaded);
  if (shown !== loaded) {
    setShown(loaded);
    setV(loaded);
  }
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState("");
  const busy = v.crons.some((x) => x.state);
  // The next look once the last one is in (a slow answer isn't dropped for a newer request).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>, live = true;
    const next = () => {
      t = setTimeout(() => void (document.hidden ? Promise.resolve(true) : onChange()).finally(() => live && next()), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    };
    next();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [busy, onChange]);

  /** `i`: the cron's row (its buttons' ids). */
  async function act(cron: string, i: number, what: "run" | "pause" | "resume") {
    const key = `${what} ${cron}`;
    setPending((s) => new Set(s).add(key));
    const done = () => setPending((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });
    try {
      const r = await api<API.Crons>(envPath(name, env, `/crons/${what}`), json("POST", { cron }));
      const msg = what === "run" ? `Running ${cron}` : `${cron} ${what === "pause" ? "paused" : "resumed"}`;
      toast(msg);
      if (!alive.current) return;
      flushSync(() => {
        done();
        setV(r);
        setStatus(msg);
      });
      void onChange(); // and a load newer than any poll already in flight (its older answer is dropped)
    } catch (e) {
      toast(`Could not ${what === "run" ? "run" : what} ${cron}: ${errorMessage(e)}`);
      if (!alive.current) return;
      flushSync(done);
      void onChange();
    }
    // The button was disabled meanwhile (focus fell to the page): back to it, or (Run now, disabled while it runs) the heading.
    refocusId(what === "run" ? "crons-title" : `cron-toggle-${i}`);
  }

  return (
    <>
      <p className="muted lead">Each cron calls your server's <code>scheduled(event, env, ctx)</code> export on its schedule, in UTC.
        {" Declare them in cresslet.json, as "}<code>{'"crons": ["*/15 * * * *"]'}</code>{" (at most 5): deploying changes them. "}
        Pausing one skips its scheduled runs until you resume it (a deploy that drops it forgets the pause); Run now still runs it.</p>
      {v.scheduled === false ? <p className="muted small" id="crons-not-scheduled">{`Crons don't run on schedule in ${v.env ?? env}: Run now runs one against its own database.`}</p> : null}
      {!a.claimed ? <p className="muted small">Crons don't run in an app without an owner (an anonymous app from before every app needed an account).</p>
        : !canManage(a.access) ? <p className="muted small">Only the owner and admins can pause or run crons.</p> : null}
      <div className="panel">
        <div className="panel-head"><h2 id="crons-title" tabIndex={-1}>Schedules</h2>
          <span className="muted small">{plural(v.crons.length, "cron")}</span>
        </div>
        {v.crons.length ? (
          <DataTable label="Crons" labelledBy="crons-title" heads={[["Schedule"], ["Next run"], ["Last run"], ["Actions", "actions", true]]}>
            {v.crons.map((x, i) => (
              <tr key={x.cron}>
                <td>
                  <span className="mono">{x.cron}</span>
                  {x.paused ? <span className="badge">paused</span> : null}
                  {x.state ? <span className="badge">{x.state}</span> : null}
                </td>
                <td className="wrap">
                  {x.paused ? <span className="muted">Paused</span>
                    : !a.claimed ? <span className="muted">Not without an owner</span>
                    : x.next[0] ? <><time dateTime={x.next[0]} title={new Date(x.next[0]).toLocaleString()}>{ago(x.next[0])}</time>
                      <span className="sub">{at(x.next[0])}{x.next[1] ? `, then ${at(x.next[1])}` : ""}</span></>
                    : <span className="muted">Never (no such date)</span>}
                </td>
                <td>
                  {x.last ? <><RunPill r={x.last} />
                    <span className="sub"><TimeAgo iso={x.last.startedAt} />{` · ${x.last.ms.toLocaleString()} ms${x.last.manual ? " · run now" : ""}`}</span></>
                    : <span className="muted">None yet</span>}
                </td>
                <td className="actions">
                  {manage ? (
                    <>
                      <button className="btn sm" type="button" id={`cron-run-${i}`} aria-label={`Run ${x.cron} now`}
                        disabled={!!x.state || pending.has(`run ${x.cron}`)} onClick={() => void act(x.cron, i, "run")}>
                        <Icon name="zap" />Run now
                      </button>
                      {v.scheduled === false ? null : (
                        <button className="btn sm" type="button" id={`cron-toggle-${i}`} aria-label={`${x.paused ? "Resume" : "Pause"} ${x.cron}`}
                          disabled={pending.has(`pause ${x.cron}`) || pending.has(`resume ${x.cron}`)}
                          onClick={() => void act(x.cron, i, x.paused ? "resume" : "pause")}>
                          {x.paused ? "Resume" : "Pause"}
                        </button>
                      )}
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <EmptyState title="No crons in this deploy">Add <code>{'"crons": ["0 * * * *"]'}</code> to cresslet.json and export <code>scheduled()</code> from your server, then deploy.</EmptyState>
        )}
      </div>
      <div className="panel mt">
        <div className="panel-head"><h2 id="cron-runs-title">Recent runs</h2>
          <span className="muted small">{`Since the server started ${ago(v.since)}`}</span>
        </div>
        {v.runs.length ? (
          <DataTable label="Recent cron runs" labelledBy="cron-runs-title" heads={[["Cron"], ["Started"], ["Result"], ["Duration", "num"]]}>
            {v.runs.map((r, i) => (
              <tr key={`${i} ${r.startedAt} ${r.cron}`}>
                <td><span className="mono">{r.cron}</span>{r.manual ? <span className="badge">run now</span> : null}</td>
                <td><TimeAgo iso={r.startedAt} /></td>
                <td><RunPill r={r} /></td>
                <td className="num">{`${r.ms.toLocaleString()} ms`}</td>
              </tr>
            ))}
          </DataTable>
        ) : <p className="muted small">No runs yet. Each run is also a line in Logs (System).</p>}
      </div>
      <p className="sr-only" role="status">{status}</p>
    </>
  );
}
