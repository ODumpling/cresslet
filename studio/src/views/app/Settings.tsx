// An app's Settings tab: custom domains, outbound network (egress) and deleting the app. Owners and admins change the
// first two; only the owner deletes it.
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
import { Icon } from "../../ui/icons.tsx";
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
