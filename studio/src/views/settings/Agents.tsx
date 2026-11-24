// /settings/agents: Live Link's remembered agents (`cresslet connect` with Remember this agent): which browser enrolled
// each, when it was last used and the projects it may reach; Forget revokes one at once (its live sessions end).
import type * as API from "../../../api-types.ts";
import { installIdentity } from "../../../live-link.ts";
import { api, errorMessage, json } from "../../lib/api.ts";
import { when } from "../../lib/format.ts";
import { useLoad, useView } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";

export function SettingsAgents() {
  useView("settings", "Connected agents · Settings");
  const agents = useLoad(() => api<{ agents: API.RememberedAgent[] }>("/v1/me/agents").then((r) => r.agents), []);
  const install = useLoad(() => installIdentity().catch(() => null), []);

  async function forget(a: API.RememberedAgent) {
    if (!confirm(`Forget ${a.label}? It loses access to all your projects at once and needs a pairing code to connect again.`)) return;
    try {
      // Proves this is one of the account's Studio browsers (a token alone can't forget agents).
      const inst = install.data ?? await installIdentity();
      await api(`/v1/me/agents/${encodeURIComponent(a.id)}/forget`, json("POST", { install: inst }));
      toast(`Forgot ${a.label}.`);
      agents.reload();
    } catch (e) {
      toast(`Could not forget ${a.label}: ${errorMessage(e)}`);
    }
  }

  return (
    <section className="block" aria-labelledby="agents-title">
      <div className="block-head">
        <h2 id="agents-title" tabIndex={-1}>Connected agents</h2>
        <p className="muted small">
          Desktop agents you told to remember (<code>cresslet connect</code>, <strong>Remember this agent</strong>). They reach only the projects
          you allowed, while those are open in the browser that allowed them. Unused for 90 days, one needs a pairing code again.
        </p>
      </div>
      <ul className="list" id="agents" aria-labelledby="agents-title">
        {agents.error ? <li className="list-row error">Could not load agents: {agents.error.message}</li>
          : !agents.data ? null
          : !agents.data.length ? <li className="list-row muted">No remembered agents.</li>
          : agents.data.map((a) => (
            <li className="list-row" key={a.id}>
              <div className="tok">
                <strong>{a.label}{install.data?.id === a.browserInstallId ? <span className="badge">this browser</span> : null}</strong>
                <span className="meta">{a.projects.length ? a.projects.map((p) => p.name).join(", ") : "no projects"}</span>
              </div>
              <span className="meta">{`remembered ${when(a.createdAt)} · last used ${when(a.lastUsedAt)}`}</span>
              <button className="btn sm danger" type="button" aria-label={`Forget ${a.label}`} id={`forget-${a.id}`} onClick={() => void forget(a)}>Forget</button>
            </li>
          ))}
      </ul>
    </section>
  );
}
