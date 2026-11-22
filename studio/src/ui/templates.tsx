// The template picker (home and landing): one card per template; picking one makes a project and opens it.
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type * as API from "../../api-types.ts";
import { api, errorMessage, mustLogIn } from "../lib/api.ts";
import { createProject } from "../lib/projects.ts";
import { logIn } from "../lib/session.ts";
import { toast } from "../lib/toast.tsx";
import { Icon, SrOnly } from "./icons.tsx";

export const TEMPLATE_ICONS: Record<string, string> = { react: "atom", vanilla: "zap", "tanstack-start": "server" };

let templatesReq: Promise<API.Template[]> | null = null;
const loadTemplates = () => templatesReq ??= api<{ templates: API.Template[] }>("/v1/templates").then(
  // `studio: false`: a CLI-only template (its framework's build doesn't run in the browser runtime)
  (r) => r.templates.filter((t) => t.studio !== false),
  (e) => {
    templatesReq = null; // try again next time
    throw e;
  },
);

export function Templates({ id, className = "grid" }: { id: string; className?: string }) {
  const [list, setList] = useState<API.Template[] | null>(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    let live = true;
    loadTemplates().then((t) => live && setList(t), (e) => live && setError(errorMessage(e)));
    return () => void (live = false);
  }, []);
  async function pick(name: string) {
    if (await mustLogIn()) return logIn();
    try {
      navigate({ to: "/p/$id", params: { id: await createProject(name) } });
    } catch (e) {
      toast(`Could not create the project: ${errorMessage(e)}`);
    }
  }
  return (
    <div className={className} id={id}>
      {error ? <p className="error">Could not load templates: {error}</p>
        : !list ? <p className="muted">Loading templates…</p>
        : list.map((t) => (
          // Its name is all its visible text (WCAG 2.5.3), with a pause between the template and its description.
          <button key={t.name} className="card" type="button" onClick={() => void pick(t.name)}>
            <span className="card-icon"><Icon name={TEMPLATE_ICONS[t.name] ?? "code"} /></span>
            <strong>{t.name}</strong>
            <SrOnly>: </SrOnly>
            <span className="desc">{t.description ?? ""}</span>
            <Icon name="arrow" className="icon go" />
          </button>
        ))}
    </div>
  );
}

/** Copies a command; if the clipboard refuses, selects `fallback` (its text) for a manual copy. */
export async function copyCommand(cmd: string, fallback: Node | null) {
  try {
    await navigator.clipboard.writeText(cmd);
    toast("Command copied");
  } catch {
    if (fallback) getSelection()!.selectAllChildren(fallback); // the document's (never null in a window)
    toast("Copy failed: the command is selected, copy it manually.");
  }
}
