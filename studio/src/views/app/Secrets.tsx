// An app's Secrets tab. Values are write-only: they can be replaced, never read back.
import { type FormEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, errorMessage, json } from "../../lib/api.ts";
import { refocusId } from "../../lib/focus.ts";
import { canManage } from "../../lib/format.ts";
import { useAlive } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";
import { FormError } from "../../ui/bits.tsx";
import { Icon, SrOnly } from "../../ui/icons.tsx";
import { appPath, useApp } from "./AppLayout.tsx";

const SECRET_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function AppSecrets() {
  const { name, d } = useApp();
  const alive = useAlive();
  const a = d.app, manage = canManage(a.access) && a.claimed;
  // The names (Refresh brings the detail's again).
  const [keys, setKeys] = useState(d.secrets);
  const [shown, setShown] = useState(d);
  if (shown !== d) {
    setShown(d);
    setKeys(d.secrets);
  }
  const [status, setStatus] = useState("");
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const keyIn = useRef<HTMLInputElement>(null);
  const valIn = useRef<HTMLTextAreaElement>(null);

  const exists = keys.includes(key.trim().toUpperCase());

  async function remove(k: string) {
    if (!confirm(`Delete secret ${k} from ${name}? The app restarts without it.`)) return;
    const done = () => setDeleting((s) => {
      const n = new Set(s);
      n.delete(k);
      return n;
    });
    setDeleting((s) => new Set(s).add(k));
    try {
      await api(appPath(name, `/secrets/${encodeURIComponent(k)}`), { method: "DELETE" });
    } catch (e) {
      if (alive.current) done();
      toast(`Could not delete ${k}: ${errorMessage(e)}`);
      return;
    }
    toast(`${k} deleted`);
    if (!alive.current) return;
    flushSync(() => {
      done();
      setKeys((ks) => ks.filter((x) => x !== k));
      setStatus(`${k} deleted`);
    });
    refocusId("secrets-title");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const k = key.trim().toUpperCase();
    if (!SECRET_RE.test(k)) {
      setErr("Use UPPER_SNAKE_CASE: letters, digits and underscores, starting with a letter or underscore (at most 64).");
      keyIn.current?.focus();
      return;
    }
    const msg = keys.includes(k) ? `${k} replaced` : `${k} added`;
    setSaving(true);
    try {
      const r = await api<{ keys: string[] }>(appPath(name, "/secrets"), json("PUT", { [k]: value }));
      toast(msg);
      if (!alive.current) return;
      flushSync(() => {
        setKeys(r.keys);
        setStatus(msg);
        setKey("");
        setValue("");
        setSaving(false);
      });
      keyIn.current?.focus();
    } catch (e2) {
      if (!alive.current) return;
      setErr(`Could not save: ${errorMessage(e2)}`);
      setSaving(false);
    }
  }

  return (
    <>
      <p className="muted lead">Your server reads these with <code>{'secrets.get("NAME")'}</code>
        {" (import { secrets } from \"cresslet\"). Values are write-only: you can replace or delete one, never read it back."}</p>
      {!a.claimed ? <p className="muted small">Secrets need an app with an owner (this is an anonymous app from before every app needed an account).</p>
        : !canManage(a.access) ? <p className="muted small">Only the owner and admins can change secrets.</p> : null}
      <div className={manage ? "detail-grid" : ""}>
        <div className="panel">
          <h2 id="secrets-title" tabIndex={-1}>Secrets</h2>
          <div className="scroll-x">
            <table className="table" aria-labelledby="secrets-title">
              <thead><tr><th scope="col">Name</th><th scope="col">Value</th><th scope="col" className="actions"><SrOnly>Actions</SrOnly></th></tr></thead>
              <tbody>
                {keys.length ? keys.map((k) => (
                  <tr key={k}>
                    <td><span className="mono">{k}</span></td>
                    <td className="muted mono" aria-hidden="true">••••••••</td>
                    <td className="actions">
                      {manage ? (
                        <>
                          <button className="btn sm" type="button" id={`replace-${k}`} aria-label={`Replace ${k}`} onClick={() => {
                            flushSync(() => {
                              setKey(k);
                              setValue("");
                            });
                            valIn.current?.focus();
                          }}>Replace</button>
                          <button className="btn sm danger" type="button" id={`delete-${k}`} aria-label={`Delete ${k}`} disabled={deleting.has(k)} onClick={() => void remove(k)}>
                            <Icon name="trash" />Delete
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                )) : <tr><td colSpan={3} className="empty">No secrets yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        {manage ? (
          <form className="panel secret-form" aria-labelledby="secret-form-title" onSubmit={(e) => void submit(e)}>
            <h2 id="secret-form-title">{exists ? `Replace ${key.trim().toUpperCase()}` : "Add a secret"}</h2>
            <div className="field">
              <label htmlFor="secret-key">Name</label>
              <input className="input mono" id="secret-key" name="key" required autoComplete="off" spellCheck={false} placeholder="STRIPE_KEY" maxLength={64}
                ref={keyIn} value={key} onChange={(e) => {
                  setErr("");
                  setKey(e.target.value);
                }} />
            </div>
            <div className="field">
              <label htmlFor="secret-value">Value</label>
              <textarea className="input mono" id="secret-value" name="value" rows={2} autoComplete="off" spellCheck={false} placeholder="Value" maxLength={32768}
                ref={valIn} value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <FormError text={err} />
            <div className="row start">
              <button className="btn primary" type="submit" disabled={saving}>{exists ? "Replace value" : "Add secret"}</button>
              <span className="muted small">Saving restarts the app with the new value.</span>
            </div>
          </form>
        ) : null}
      </div>
      <p className="sr-only" role="status">{status}</p>
    </>
  );
}
