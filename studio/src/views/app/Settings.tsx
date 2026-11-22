// An app's Settings tab: custom domains, outbound network (egress), its repository (source control) and deleting the
// app. Owners and admins change the first three; only the owner deletes it.
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json, meta } from "../../lib/api.ts";
import { refocusId } from "../../lib/focus.ts";
import { canManage } from "../../lib/format.ts";
import { useAlive, useLoad } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";
import { DataTable, FormError } from "../../ui/bits.tsx";
import { ExtLink, Icon } from "../../ui/icons.tsx";
import { gitCode } from "../../../git.ts";
import { connectGithub } from "../workspace/GitDialog.tsx";
import { appPath, TabError, useApp, useTabReload } from "./AppLayout.tsx";

export function AppSettings() {
  const { d } = useApp();
  const a = d.app;
  return (
    <>
      {!a.claimed ? <p className="muted small">Domains and outbound network need a claimed app: run cresslet claim, or deploy it while logged in.</p>
        : !canManage(a.access) ? <p className="muted small">Only the owner and admins can change these settings.</p> : null}
      {a.claimed ? <Domains /> : null}
      {a.config?.server ? <Egress /> : null}
      {a.claimed && canManage(a.access) ? <Repository key={`repo:${a.id}`} /> : null}
      {/* by id: a different app under this name (after a Refresh) needs its own confirmation */}
      {a.access === "owner" ? <Delete key={a.id} /> : null}
    </>
  );
}

function Domains() {
  const { name, d } = useApp();
  const alive = useAlive();
  const manage = canManage(d.app.access);
  const list = useLoad(() => api<{ domains: API.DomainDetail[] }>(appPath(name, "/domains")).then((r) => r.domains), [name], { keep: true });
  useTabReload(list.reload);
  // Custom domains off on this server (CRESSLET_CUSTOM_DOMAINS=false): existing ones can still be removed.
  const [off, setOff] = useState(false);
  useEffect(() => {
    let live = true;
    void meta().then((m) => live && setOff(m.customDomains === false));
    return () => void (live = false);
  }, []);
  const [domains, setDomains] = useState<API.DomainDetail[] | undefined>(list.data);
  const [shown, setShown] = useState(list.data);
  if (shown !== list.data) {
    setShown(list.data);
    setDomains(list.data);
  }
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState("");
  const mark = (k: string, on: boolean) => setBusy((s) => {
    const n = new Set(s);
    if (on) n.add(k);
    else n.delete(k);
    return n;
  });
  const put = (x: API.DomainDetail) => setDomains((ds) => ds?.some((y) => y.domain === x.domain) ? ds.map((y) => (y.domain === x.domain ? x : y)) : [...ds ?? [], x]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr("");
    mark("+", true);
    try {
      const r = await api<{ domain: API.DomainDetail }>(appPath(name, "/domains"), json("POST", { domain: input.trim() }));
      toast(`${r.domain.domain} added: set its DNS records, then Verify`);
      if (!alive.current) return;
      flushSync(() => {
        put(r.domain);
        setInput("");
        setStatus(`${r.domain.domain} added`);
      });
    } catch (e2) {
      if (alive.current) setErr(`Could not add: ${errorMessage(e2)}`);
    }
    if (!alive.current) return;
    flushSync(() => mark("+", false));
    refocusId("domain-input"); // if the disabled Add button had it
  }

  async function verify(domain: string) {
    mark(domain, true);
    try {
      const r = await api<{ domain: API.DomainDetail }>(appPath(name, `/domains/${encodeURIComponent(domain)}/verify`), json("POST", {}));
      toast(`${domain} verified`);
      if (!alive.current) return;
      flushSync(() => {
        mark(domain, false);
        put(r.domain);
        setStatus(`${domain} verified`);
      });
      refocusId(`domain-remove-${domain}`); // Verify is gone
    } catch (e) {
      toast(`Could not verify ${domain}: ${errorMessage(e)}`);
      if (!alive.current) return;
      flushSync(() => mark(domain, false));
      refocusId(`domain-verify-${domain}`);
    }
  }

  async function remove(domain: string) {
    if (!confirm(`Remove ${domain} from ${name}? It stops serving the app at once.`)) return;
    mark(domain, true);
    try {
      await api(appPath(name, `/domains/${encodeURIComponent(domain)}`), { method: "DELETE" });
      toast(`${domain} removed`);
      if (!alive.current) return;
      flushSync(() => {
        mark(domain, false);
        // Only this row: the answer's list could be older than another row's Verify that finished meanwhile.
        setDomains((ds) => ds?.filter((x) => x.domain !== domain));
        setStatus(`${domain} removed`);
      });
      refocusId("domains-title");
    } catch (e) {
      toast(`Could not remove ${domain}: ${errorMessage(e)}`);
      if (!alive.current) return;
      flushSync(() => mark(domain, false));
      refocusId(`domain-remove-${domain}`);
    }
  }

  return (
    <section className="panel" aria-labelledby="domains-title">
      <h2 id="domains-title" tabIndex={-1}>Custom domains</h2>
      <p className="muted small">{off ? "Custom domains are turned off on this server." : `Serve ${name} at your own domain too: add it, point a CNAME at the app and prove you own it with a TXT record, then Verify. At most 10.`}</p>
      {domains ? (
        domains.length ? (
          <DataTable label="Custom domains" labelledBy="domains-title" heads={[["Domain"], ["DNS records"], ["Actions", "actions", true]]}>
            {domains.map((x) => (
              <tr key={x.domain}>
                <td><span className="mono">{x.domain}</span><span className="badge">{x.verified ? "verified" : "pending"}</span></td>
                <td className="wrap">
                  {x.verified ? <span className="muted">Serving</span> : x.dns.map((r) => (
                    <span className="sub mono" key={r.type}>{`${r.type} ${r.name} → ${r.value}`}</span>
                  ))}
                </td>
                <td className="actions">
                  {manage ? (
                    <>
                      {!x.verified && !off ? <button className="btn sm" type="button" id={`domain-verify-${x.domain}`} aria-label={`Verify ${x.domain}`} disabled={busy.has(x.domain)} onClick={() => void verify(x.domain)}>Verify</button> : null}
                      <button className="btn sm danger" type="button" id={`domain-remove-${x.domain}`} aria-label={`Remove ${x.domain}`} disabled={busy.has(x.domain)} onClick={() => void remove(x.domain)}>
                        <Icon name="trash" />Remove
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </DataTable>
        ) : <p className="muted small">No custom domains.</p>
      ) : list.error ? <TabError error={list.error} /> : <p className="muted small">Loading…</p>}
      {manage && !off ? (
        <form className="token-row" aria-label="Add a custom domain" onSubmit={(e) => void add(e)}>
          <input className="input mono" id="domain-input" aria-label="Domain" required placeholder="app.example.com" autoComplete="off" spellCheck={false}
            maxLength={253} value={input} onChange={(e) => {
              setErr("");
              setInput(e.target.value);
            }} />
          <button className="btn primary" type="submit" disabled={busy.has("+")}><Icon name="plus" />Add domain</button>
        </form>
      ) : null}
      <FormError text={err} />
      <p className="sr-only" role="status">{status}</p>
    </section>
  );
}

function Egress() {
  const { name, d, refresh } = useApp();
  const alive = useAlive();
  const a = d.app, manage = canManage(a.access) && a.claimed;
  const [mode, setMode] = useState<"any" | "list">(a.egress === null ? "any" : "list");
  const [hosts, setHosts] = useState((a.egress ?? []).join("\n"));
  const [shown, setShown] = useState(a.egress);
  if (shown !== a.egress) {
    setShown(a.egress);
    setMode(a.egress === null ? "any" : "list");
    setHosts((a.egress ?? []).join("\n"));
  }
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr("");
    const allow = mode === "any" ? null : hosts.split(/[\s,]+/).filter(Boolean);
    setSaving(true);
    try {
      await api(appPath(name, "/egress"), json("PUT", { allow }));
      toast(allow ? `Outbound network: ${allow.length ? allow.join(", ") : "none"}` : "Outbound network: any public host");
      if (alive.current) await refresh();
    } catch (e2) {
      if (alive.current) setErr(`Could not save: ${errorMessage(e2)}`);
    }
    if (!alive.current) return;
    flushSync(() => setSaving(false));
    refocusId("egress-save"); // it was disabled while saving
  }

  return (
    <form className="panel form mt" aria-labelledby="egress-title" onSubmit={(e) => void save(e)}>
      <h2 id="egress-title">Outbound network</h2>
      <fieldset className="field">
        <legend>Hosts your server may <code>fetch</code></legend>
        <label className="check"><input type="radio" name="egress" value="any" disabled={!manage || saving} checked={mode === "any"} onChange={() => setMode("any")} /><span>Any public host</span></label>
        <label className="check"><input type="radio" name="egress" value="list" disabled={!manage || saving} checked={mode === "list"} onChange={() => setMode("list")} /><span>Only these hosts</span></label>
      </fieldset>
      {mode === "list" ? (
        <div className="field">
          <label htmlFor="egress-hosts">Allowed hosts, one per line</label>
          <textarea className="input mono" id="egress-hosts" rows={4} aria-describedby="egress-hint" spellCheck={false} disabled={!manage || saving}
            placeholder={"api.stripe.com\n*.openai.com"} value={hosts} onChange={(e) => {
              setErr("");
              setHosts(e.target.value);
            }} />
          <p className="muted small" id="egress-hint"><code>*.example.com</code> allows its subdomains only. At most 50. Leave it empty to block all outbound requests.</p>
        </div>
      ) : null}
      <FormError text={err} />
      {manage ? (
        <div className="row start">
          <button className="btn primary" type="submit" id="egress-save" disabled={saving}>Save</button>
          <span className="muted small">Saving restarts the app.</span>
        </div>
      ) : null}
    </form>
  );
}

/**
 * Links the app to a GitHub repository without opening it in a workspace: a new repository, or one the user has,
 * starting from the source uploaded with its live deploy (or, for one the user has, its own files). The studio's
 * workspace then loads it (Source control → Load).
 */
function Repository() {
  const { name, d, refresh } = useApp();
  const alive = useAlive();
  const me = useLoad(() => api<API.MeGit>("/v1/me/git"), []);
  const g = me.data, active = !!g?.connected && g.status === "active", linked = d.repo ?? null;
  const repos = useLoad(() => active && !linked ? api<{ repos: API.GitRepo[] }>("/v1/git/github/repos").then((r) => r.repos) : Promise.resolve(null), [active, !!linked], { keep: true });
  // The live deploy's source, to push (a deploy without it, or nothing deployed: only a repository the user has).
  const deployed = !!d.deploys.find((x) => x.current)?.hasSource;
  const [mode, setMode] = useState<"create" | "link">(deployed ? "create" : "link");
  const [repoName, setRepoName] = useState(name);
  const [priv, setPriv] = useState(true);
  const [picked, setPicked] = useState("");
  const [initial, setInitial] = useState<"deploy" | "none" | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  // The one picked (by GitHub's id: a renamed one's old name may be another's now), or the first by default; none when a
  // reload dropped the one picked (chosen again, never swapped).
  const pickRepo = picked ? repos.data?.find((r) => r.id === picked) : repos.data?.[0];
  const pick = pickRepo?.fullName ?? "";
  // Back from choosing which repositories Cresslet reaches (another tab): the list may have changed.
  const reloadRepos = repos.reload;
  useEffect(() => {
    if (!active || linked) return;
    const f = () => void reloadRepos();
    addEventListener("focus", f);
    return () => removeEventListener("focus", f);
  }, [active, linked, reloadRepos]);
  // GitHub access revoked since /v1/me/git said active: show Reconnect.
  const reloadMe = me.reload;
  const reauth = (e: unknown) => void (gitCode(e) === "git_reauth_required" && reloadMe());
  useEffect(() => reauth(repos.error), [repos.error]);

  // Back from connecting GitHub (server/git.ts puts the outcome in the hash).
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    const ok = h.get("cresslet_git"), e = h.get("cresslet_git_error");
    if (!ok && !e) return;
    history.replaceState(null, "", location.pathname + location.search);
    toast(e ? `GitHub didn't connect: ${e}` : "GitHub connected", 8000);
  }, []);

  async function run(label: string, fn: () => Promise<string | void>) {
    setErr("");
    setBusy(label);
    try {
      const done = await fn();
      if (done) toast(done);
      if (alive.current) await refresh();
    } catch (e) {
      if (alive.current) setErr(errorMessage(e));
      reauth(e);
    }
    if (alive.current) setBusy("");
  }

  const link = (e: FormEvent) => {
    e.preventDefault();
    const sync = mode === "create" || initial === "deploy" ? (deployed ? "deploy" : null) : initial;
    if (mode === "link" && !pick) return setErr("Choose a repository.");
    if (!sync) return setErr("Choose what the repository starts with.");
    if (mode === "link" && sync === "deploy" && !confirm(`Push ${name}'s live source to ${pick}? Its default branch then holds exactly these files: others there are deleted.`)) return;
    void run(mode === "create" ? "Creating the repository…" : "Linking…", async () => {
      let owner: string, repo: string, created: API.GitRepo | null = null;
      if (mode === "create") {
        const r = await api<{ repo: API.GitRepo }>("/v1/git/github/repos", json("POST", { name: repoName.trim(), private: priv }));
        [owner, repo, created] = [r.repo.owner, r.repo.name, r.repo];
      } else {
        [owner, repo] = [pickRepo!.owner, pickRepo!.name]; // pick: checked above
      }
      try {
        const r = await api<{ repo: API.AppRepo }>(appPath(name, "/git/connect"), json("POST", {
          owner, repo, initialSync: sync, ...(sync === "deploy" ? { message: `Add ${name} from Cresslet` } : {}),
        }));
        return `Linked to ${r.repo.fullName}`;
      } catch (e) {
        if (!created) throw e;
        // The repository is there now: offered as one the user has, not created again.
        await reloadRepos();
        if (alive.current) {
          setMode("link");
          setPicked(created.id);
          setInitial(null); // the user chooses the first sync again; the new repository may not be listed yet
        }
        throw Object.assign(new Error(`Created ${created.fullName}, but couldn't link it: ${errorMessage(e)}. Link it below to try again.`), { code: gitCode(e) });
      }
    });
  };

  if (!g?.available) return null;
  return (
    <section className="panel form mt" aria-labelledby="repo-title">
      <h2 id="repo-title">Source control</h2>
      {linked ? (
        <>
          <p id="repo-linked">{"Linked to "}<ExtLink href={linked.url}>{linked.fullName}</ExtLink>{` (${linked.defaultBranch}).${deployed ? ` To work on it in the studio: Open source, then Source control → Load ${linked.defaultBranch}.` : ""}`}</p>
          <div className="row start">
            <button className="btn danger sm" type="button" id="repo-unlink" disabled={!!busy} onClick={() => {
              if (!confirm(`Unlink ${name} from ${linked.fullName}? The repository is left as it is.`)) return;
              void run("Unlinking…", async () => {
                await api(appPath(name, "/git"), { method: "DELETE" });
                return "Unlinked";
              });
            }}>Unlink repository</button>
          </div>
        </>
      ) : !active ? (
        <>
          <p className="muted small">{g.status === "expired"
            ? `GitHub access for ${g.login} expired or was revoked: connect again to link ${name} to a repository.`
            : `Keep ${name} in a GitHub repository: connect your GitHub account first. Cresslet commits as you; your token stays on the server.`}</p>
          <div className="row start">
            <button className="btn primary" type="button" id="repo-connect-github" disabled={!!busy} onClick={() => void run("Opening GitHub…", () => connectGithub())}>
              <Icon name="github" />{g.status === "expired" ? "Reconnect GitHub" : "Connect GitHub"}
            </button>
          </div>
        </>
      ) : (
        <form className="form" id="repo-form" onSubmit={link}>
          <p className="muted small">{deployed
            ? `Starts from the source uploaded with ${name}'s live deploy. Left out: .env.local, .dev.vars and the like; .env files keep only their public entries.`
            : d.app.currentDeployId ? `${name}'s live deploy has no source uploaded with it: link a repository you have, or deploy ${name} with its source first.`
            : `Nothing is deployed yet: link a repository you have, or deploy ${name} first.`}</p>
          <fieldset className="field">
            <legend>Repository</legend>
            <label className="check"><input type="radio" name="repo-mode" checked={mode === "create"} disabled={!deployed} onChange={() => setMode("create")} /><span>Create a new repository</span></label>
            <label className="check"><input type="radio" name="repo-mode" checked={mode === "link"} disabled={!repos.data?.length} onChange={() => setMode("link")} /><span>Link a repository you have</span></label>
          </fieldset>
          {mode === "create" ? (
            <>
              <div className="field">
                <label htmlFor="repo-name">Name (under {g.login})</label>
                <input id="repo-name" className="input" required pattern="[\w.\-]{1,100}" value={repoName} onChange={(e) => setRepoName(e.target.value)} />
              </div>
              <label className="check"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /><span>Private</span></label>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="repo-pick">Repository</label>
                <select id="repo-pick" className="input" value={pickRepo?.id ?? ""} onChange={(e) => setPicked(e.target.value)}>
                  {!pick ? <option value="" disabled>Choose a repository</option> : null}
                  {repos.data?.map((r) => <option key={r.id} value={r.id}>{r.fullName}{r.private ? " (private)" : ""}</option>)}
                </select>
              </div>
              <fieldset className="field">
                <legend>First sync</legend>
                <label className="check"><input type="radio" name="repo-initial" checked={initial === "deploy"} disabled={!deployed} onChange={() => setInitial("deploy")} /><span>Push the live deploy's source: its default branch then holds exactly these files (others there are deleted)</span></label>
                <label className="check"><input type="radio" name="repo-initial" checked={initial === "none"} onChange={() => setInitial("none")} /><span>Keep the repository's files: link it without changing it</span></label>
              </fieldset>
            </>
          )}
          {g.installUrl ? <p className="muted small">Missing a repository? <ExtLink href={g.installUrl}>Choose which repositories Cresslet can reach</ExtLink>.</p> : null}
          {repos.error ? <p className="error small">{repos.error.message}</p> : null}
          <div className="row start">
            <button className="btn primary" type="submit" id="repo-link" disabled={!!busy || (mode === "create" ? !deployed : !pick || !initial || (initial === "deploy" && !deployed))}>
              <Icon name="github" />{mode === "create" ? "Create and push" : "Link"}
            </button>
          </div>
        </form>
      )}
      <FormError text={err} />
      <p className="sr-only" role="status">{busy}</p>
      {busy ? <p className="muted small" aria-hidden="true"><span className="spinner" /> {busy}</p> : null}
    </section>
  );
}

function Delete() {
  const { name, d } = useApp();
  const navigate = useNavigate();
  const alive = useAlive();
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function del(e: FormEvent) {
    e.preventDefault();
    if (typed.trim() !== name) return;
    setBusy(true);
    try {
      // The app this page shows, not one made with its name since (deleted and recreated elsewhere): 409 then.
      await api(appPath(name, `?id=${encodeURIComponent(d.app.id)}`), { method: "DELETE" });
    } catch (e2) {
      if (!alive.current) return;
      flushSync(() => {
        setErr(`Could not delete: ${errorMessage(e2)}`);
        setBusy(false);
      });
      refocusId("delete-app"); // it was disabled meanwhile
      return;
    }
    toast(`${name} deleted`);
    if (alive.current) void navigate({ to: "/" });
  }

  return (
    <form className="panel form mt" aria-labelledby="delete-title" onSubmit={(e) => void del(e)}>
      <h2 id="delete-title">Delete this app</h2>
      <p className="muted small">Deletes {name} with its deploys, database, files, secrets and domains, now and for good. Its name becomes free for anyone.</p>
      <div className="field">
        <label htmlFor="delete-confirm">Type <span className="mono">{name}</span> to confirm</label>
        <input className="input mono" id="delete-confirm" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => {
          setErr("");
          setTyped(e.target.value);
        }} />
      </div>
      <FormError text={err} />
      <div className="row start">
        <button className="btn danger" type="submit" id="delete-app" disabled={busy || typed.trim() !== name}><Icon name="trash" />Delete app</button>
      </div>
    </form>
  );
}
