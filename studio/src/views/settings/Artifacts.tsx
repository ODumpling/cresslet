// /settings/artifacts: the account's defaults for new artifacts (who can open them, how long they're kept).
import { useEffect, useState } from "react";
import type * as API from "../../../api-types.ts";
import { api, errorMessage, json } from "../../lib/api.ts";
import { keepOptions, keepParse, keepText, keepValue, VIS_LABEL } from "../../lib/format.ts";
import { useAlive, useLoad, useView } from "../../lib/hooks.ts";
import { toast } from "../../lib/toast.tsx";
import { FormError } from "../../ui/bits.tsx";

/** The account's defaults for new artifacts. */
export function SettingsArtifacts() {
  useView("settings", "Artifact defaults · Settings");
  const alive = useAlive();
  const loaded = useLoad(() => api<API.Settings>("/v1/me/settings"), []);
  const [settings, setSettings] = useState<API.Settings | null>(null);
  const [vis, setVis] = useState("private");
  const [keep, setKeep] = useState("1");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const show = (s: API.Settings) => {
    setSettings(s);
    setVis(s.pages.visibility);
    setKeep(keepValue(s.pages.retentionDays));
  };
  useEffect(() => {
    if (loaded.data) show(loaded.data);
    else if (loaded.error) setError(`Could not load your artifact defaults: ${loaded.error.message}`);
  }, [loaded.data, loaded.error]);

  async function save(pages: { visibility: string; retentionDays: number | null } | null, done: string) {
    setError("");
    setBusy(true);
    try {
      const s = await api<API.Settings>("/v1/me/settings", json("PUT", { pages }));
      if (!alive.current) return;
      show(s);
      toast(done);
    } catch (e) {
      if (alive.current) setError(`Could not save: ${errorMessage(e)}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const d = settings?.defaults.pages;
  // The retention choices, plus the saved one if it was set elsewhere (CLI or API) and isn't one of them.
  const options = keepOptions(settings ? settings.pages.retentionDays : 1);
  return (
    <section className="block" aria-labelledby="page-defaults-title">
      <div className="block-head">
        <h2 id="page-defaults-title">Artifact defaults</h2>
        <p className="muted small">Used for new artifacts unless you pick something else when you deploy one. Change any artifact later.</p>
      </div>
      <form id="page-defaults-form" className="panel form" aria-labelledby="page-defaults-title" onSubmit={(e) => {
        e.preventDefault();
        void save({ visibility: vis, retentionDays: keepParse(keep) }, "Artifact defaults saved");
      }}>
        <div className="field">
          <label htmlFor="def-visibility">Who can open new artifacts</label>
          <select className="input" id="def-visibility" aria-describedby="vis-hint-def" value={vis} onChange={(e) => setVis(e.target.value)}>
            <option value="private">Private</option>
            <option value="link">Anyone with the link</option>
            <option value="public">Public</option>
          </select>
          <p className="muted small" id="vis-hint-def">Private: you and people you share it with, logged in. Anyone with the link: not listed by search engines. Public: anyone, search engines too.</p>
        </div>
        <div className="field">
          <label htmlFor="def-retention">Keep new artifacts for</label>
          <select className="input" id="def-retention" aria-describedby="def-hint" value={keep} onChange={(e) => setKeep(e.target.value)}>
            {options.map((v) => <option key={v} value={v}>{keepText(keepParse(v))}</option>)}
          </select>
          <p className="muted small" id="def-hint">Server default: <span id="def-server">{d
            ? `${VIS_LABEL[d.visibility].toLowerCase()}, kept ${d.retentionDays === null ? "forever" : `for ${keepText(d.retentionDays).toLowerCase()}`}`
            : "—"}</span>. Expired artifacts are deleted.</p>
        </div>
        <FormError id="page-defaults-error" text={error} />
        <div className="row start">
          <button className="btn primary" id="page-defaults-save" type="submit" disabled={busy || !settings}>Save defaults</button>
          <button className="btn" id="page-defaults-reset" type="button" disabled={busy || !settings} onClick={() => void save(null, "Using the server's artifact defaults")}>Use server defaults</button>
        </div>
      </form>
    </section>
  );
}
