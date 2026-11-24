// An app's Overview tab: status, requests, storage, its repository and deploys (with rollback).
import { Link } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json } from "../../lib/api.ts";
import { refocusId } from "../../lib/focus.ts";
import { ago, canManage, fmtBytes, plural, STATUS } from "../../lib/format.ts";
import { useAlive, useLoad } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";
import { Stat, StatusPill, TimeAgo, UsageBar } from "../../ui/bits.tsx";
import { ExtLink, Icon, SrOnly } from "../../ui/icons.tsx";
import { envPath, TabError, useApp, useTabReload } from "./AppLayout.tsx";

export function AppOverview() {
  const { name, env } = useApp();
  const m = useLoad(() => api<API.Metrics>(envPath(name, env, "/metrics")), [name, env]);
  useTabReload(m.reload);
  if (m.data) return <Body m={m.data} />;
  if (m.error) return <TabError error={m.error} />;
  return <p className="muted">Loading…</p>;
}

/** Requests per hour over the last 24 hours (the 5-minute buckets summed), errors shown at the foot of each bar. */
function RequestChart({ series, bucketMs }: { series: API.Metrics["series"]; bucketMs: number }) {
  const per = Math.max(1, Math.round(3_600_000 / bucketMs));
  const hours: API.Metrics["series"] = [];
  for (let i = 0; i < series.length; i += per) {
    const part = series.slice(i, i + per);
    hours.push({ t: part[0]!.t, requests: part.reduce((n, b) => n + b.requests, 0), errors: part.reduce((n, b) => n + b.errors, 0) });
  }
  const max = Math.max(...hours.map((h) => h.requests));
  const total = hours.reduce((n, h) => n + h.requests, 0), errors = hours.reduce((n, h) => n + h.errors, 0);
  const fmt = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const peak = hours.reduce((a, h) => (h.requests > a.requests ? h : a), hours[0]!); // 24 hours of buckets
  const label = max
    ? `Requests per hour over the last 24 hours: ${plural(total, "request")}, ${plural(errors, "server error")}; busiest hour from ${fmt(peak.t)} (${peak.requests.toLocaleString()})`
    : "No requests in the last 24 hours";
  return (
    <div>
      <div className="day-chart req-chart" role="img" aria-label={label}>
        {hours.map((h) => (
          <span key={h.t} title={`${fmt(h.t)}: ${plural(h.requests, "request")}${h.errors ? `, ${plural(h.errors, "server error")}` : ""}`}
            style={{ height: max ? `${Math.max(h.requests ? 3 : 0, (h.requests / max) * 100)}%` : "0" }}>
            {h.errors ? <i className="err" style={{ height: `${Math.max(8, (h.errors / h.requests) * 100)}%` }} /> : null}
          </span>
        ))}
      </div>
      <div className="day-axis" aria-hidden="true">
        <span>24 hours ago</span><span>{max ? `peak ${peak.requests.toLocaleString()}/h` : ""}</span><span>Now</span>
      </div>
    </div>
  );
}

const KvList = ({ pairs }: { pairs: ([string, ReactNode] | null)[] }) => (
  <dl className="kv">
    {pairs.filter((x) => x !== null).map(([k, v]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>])}
  </dl>
);

function Body({ m }: { m: API.Metrics }) {
  const { name, env, d } = useApp();
  const a = d.app, rt = d.runtime, dep = d.deploys.find((x) => x.current);
  const here = d.environments?.find((e) => e.name === env);
  const prod = env === "production";
  const status = rt.running ? "running" : (prod ? a.currentDeployId : here?.currentDeployId) ? "idle" : "empty";
  const config = prod ? a.config : here?.config;
  const manage = canManage(a.access);
  const db = m.database;
  const t = m.totals;
  const sinceRestart = Date.now() - new Date(m.since).getTime() < 86_400_000;
  const domains = m.domains.filter((x) => x.verified);
  const git = dep?.git;

  return (
    <>
      {dep ? (
        <div className="banner"><StatusPill s="live" text={prod ? "Live" : `Live in ${env}`} />
          <span><span className="mono">{dep.id}</span>{` deployed ${ago(dep.createdAt)} via ${dep.source}`}</span>
        </div>
      ) : <div className="banner">Nothing deployed yet.</div>}
      <Promote />
      <div className="stats">
        <Stat label="Status" value={STATUS[status]} sub={rt.running ? "Serving requests" : config?.server ? "Starts on the next request" : "Static site"}
          extra={<i className="dot" aria-hidden="true" data-s={status} />} />
        <Stat label="Requests" value={<>{t.requests.toLocaleString()}<small>24h</small></>}
          sub={`${plural(t.errors, "server error")} · ${t.requests ? Math.round((t.errors / t.requests) * 1000) / 10 : 0}% · ${t.clientErrors.toLocaleString()} 4xx`} />
        <Stat label="Response time" value={t.avgMs === null ? "—" : `${t.avgMs.toLocaleString()} ms`}
          sub={t.maxMs === null ? (a.config?.server ? "No server requests yet" : "Static files only") : `Average · slowest ${t.maxMs.toLocaleString()} ms`} />
        <Stat label="Storage" value={fmtBytes(m.usage.total)}
          sub={db.error ? "Database couldn't be read" : db.tables.length ? `Database ${fmtBytes(m.usage.database)} · ${plural(db.tables.length, "table")}` : "No database yet"} />
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Requests</h2>
          <span className="muted small">{sinceRestart ? `Counted since the server started ${ago(m.since)}` : "Last 24 hours"}</span>
        </div>
        <RequestChart series={m.series} bucketMs={m.bucketMs} />
      </div>
      <div className="detail-grid mt">
        <div className="panel">
          <h2>Overview</h2>
          <KvList pairs={[
            ["URL", <ExtLink href={here?.url ?? a.url}>{(here?.url ?? a.url).replace(/^https?:\/\//, "")}</ExtLink>],
            prod ? null : ["Access", "Private: you, the app's collaborators and its organization (signed in)"],
            prod ? ["Domains", domains.length ? <span>{domains.map((x, i) => <span key={x.domain}>{i ? ", " : null}<ExtLink href={`https://${x.domain}`}>{x.domain}</ExtLink></span>)}</span> : "—"] : null,
            ["Repository", d.repo ? <ExtLink href={d.repo.url} id="app-repo">{d.repo.fullName}</ExtLink> : "Not linked"],
            d.repo ? ["Default branch", <span className="mono" id="app-branch">{d.repo.defaultBranch}</span>] : null,
            d.repo || git ? ["Commit", git ? <Commit git={git} repo={d.repo} /> : dep ? "No commit recorded" : "—"] : null,
            ["Server", config?.server ? `Yes${config.crons?.length ? ` · ${plural(config.crons.length, "cron")}${prod ? "" : " (Run now only)"}` : ""}` : "Static only"],
            ["Secrets", <Link to="/apps/$name/secrets" params={{ name }}>{d.secrets.length ? plural(d.secrets.length, "secret") : "None"}</Link>],
            ["Egress", a.egress === null ? "Any public host" : a.egress.length ? a.egress.join(", ") : "None"],
            a.expiresAt ? ["Expires", ago(a.expiresAt)] : null,
            ["Created", new Date(a.createdAt).toLocaleString()],
            ["App ID", <span className="mono">{a.id}</span>],
          ]} />
          <h2 className="mt">Storage</h2>
          <UsageBar u={m.usage} />
        </div>
        <div className="stack">
          <Deploys manage={manage} />
        </div>
      </div>
    </>
  );
}

/**
 * The live deploy's commit: short sha (linked when it's on GitHub), its version tag, and where it's from when that
 * isn't the linked repository's default branch (another branch, another repository, or none linked).
 */
function Commit({ git, repo }: { git: NonNullable<API.DeployInfo["git"]>; repo: API.AppRepo | null | undefined }) {
  const sha = git.sha.slice(0, 7);
  const other = !!git.repo && git.repo.toLowerCase() !== repo?.fullName.toLowerCase(); // GitHub names ignore case
  const extra = [git.tag, other ? `from ${git.repo}` : null, git.branch && (other || git.branch !== repo?.defaultBranch) ? `on ${git.branch}` : null]
    .filter(Boolean).join(" · ");
  return (
    <span id="app-commit">
      {git.url
        ? <ExtLink className="ext mono" href={git.url} title={git.sha}><SrOnly>Commit </SrOnly>{sha}</ExtLink>
        : <span className="mono" title={git.sha}>{sha}</span>}
      {extra ? ` · ${extra}` : null}
    </span>
  );
}

/**
 * Staging's deploy, when production doesn't serve it: Promote makes production serve that same bundle (no rebuild). On a
 * linked repository the server first moves the default branch to its commit (fast-forward only) and tags it.
 */
function Promote() {
  const { name, d, refresh } = useApp();
  const alive = useAlive();
  const [busy, setBusy] = useState(false);
  const prodEnv = d.environments?.find((e) => e.name === "production");
  const staging = d.environments?.find((e) => e.name === "staging");
  if (!staging?.currentDeployId || !canManage(d.app.access) || staging.currentDeployId === prodEnv?.currentDeployId) return null;
  const id = staging.currentDeployId;
  async function promote() {
    const linked = d.repo ? `\n\n${d.repo.fullName}'s ${d.repo.defaultBranch} moves to the commit it was built from (fast-forward only), which gets the next version tag.` : "";
    if (!confirm(`Promote ${id} from staging to production?\n\nProduction serves this same deploy from the next request, with production's own data and secrets.${linked}`)) return;
    setBusy(true);
    try {
      const r = await api<{ deploy: { tag?: string; warning?: string } }>(envPath(name, "production", "/promote"), json("POST", { from: "staging", deployId: id, expectProduction: prodEnv?.currentDeployId ?? null }));
      toast(`${id} promoted to production${r.deploy.tag ? ` as ${r.deploy.tag}` : ""}${r.deploy.warning ? ` (${r.deploy.warning})` : ""}`);
    } catch (e) {
      toast(`Could not promote: ${errorMessage(e)}`);
    }
    if (!alive.current) return;
    await refresh();
    if (alive.current) setBusy(false);
  }
  return (
    <div className="banner" id="promote-banner">
      <span>{"Staging serves "}<span className="mono">{id}</span>{", not in production yet."}</span>
      <button className="btn sm primary" type="button" id="promote" disabled={busy} onClick={() => void promote()}><Icon name="ship" />Promote to production</button>
    </div>
  );
}

function Deploys({ manage }: { manage: boolean }) {
  const { name, env, d, refresh } = useApp();
  const alive = useAlive();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  async function rollback(dep: API.DeployInfo) {
    if (!confirm(`Roll ${name} back to ${dep.id} (deployed ${ago(dep.createdAt)})?\n\nIt serves that deploy's files and server from the next request. Its database, files and secrets stay as they are.`)) return;
    setBusy((s) => new Set(s).add(dep.id));
    try {
      await api(envPath(name, "production", "/rollback"), json("POST", { deployId: dep.id, env }));
    } catch (e) {
      toast(`Could not roll back: ${errorMessage(e)}`);
      if (!alive.current) return;
      flushSync(() => setBusy((s) => {
        const n = new Set(s);
        n.delete(dep.id);
        return n;
      }));
      buttons.current.get(dep.id)?.focus();
      return;
    }
    toast(`${name} rolled back to ${dep.id}`);
    if (!alive.current) return;
    const ok = await refresh();
    if (!alive.current) return;
    flushSync(() => setBusy((s) => {
      const n = new Set(s);
      n.delete(dep.id);
      return n;
    }));
    if (ok) refocusId("deploys-title");
  }

  return (
    <div className="panel">
      <div className="panel-head"><h2 id="deploys-title" tabIndex={-1}>Deploys</h2>
        <span className="muted small">{`${plural(d.deploys.length, "deploy")} kept`}</span>
      </div>
      {d.deploys.length ? (
        <div className="scroll-x" tabIndex={0} role="region" aria-label="Deploys">
          <table className="table">
            <thead><tr><th scope="col">Deploy</th><th scope="col" className="actions"><SrOnly>Actions</SrOnly></th></tr></thead>
            <tbody>
              {d.deploys.map((x) => (
                <tr key={x.id}>
                  <td>
                    <span className="mono">{x.id}</span>
                    {x.current ? <span className="badge">live</span> : null}
                    <span className="sub"><TimeAgo iso={x.createdAt} />{` · ${fmtBytes(x.bytes)} · ${plural(x.files, "file")} · via ${x.source}`}
                      {x.git ? <>{" · "}{x.git.url
                        ? <ExtLink className="mono git-ref" href={x.git.url} title={`Built from ${x.git.repo} ${x.git.branch ?? ""} @ ${x.git.sha}`}>{`${x.git.tag ? `${x.git.tag} · ` : ""}${x.git.branch ?? "commit"} @ ${x.git.sha.slice(0, 7)}`}</ExtLink>
                        : <span className="mono git-ref">{`${x.git.tag ? `${x.git.tag} · ` : ""}${x.git.branch ?? "commit"} @ ${x.git.sha.slice(0, 7)}`}</span>}</> : null}
                    </span>
                  </td>
                  <td className="actions">
                    {manage && !x.current ? (
                      <button className="btn sm" type="button" id={`rollback-${x.id}`} aria-label={`Roll back to ${x.id}`} disabled={busy.has(x.id)}
                        ref={(b) => {
                          if (b) buttons.current.set(x.id, b);
                          else buttons.current.delete(x.id);
                        }}
                        onClick={() => void rollback(x)}>Roll back</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted small">No deploys.</p>}
    </div>
  );
}
