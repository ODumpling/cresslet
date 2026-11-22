// Local projects (IndexedDB, store.ts): making one from a template or a deployed app's source, and telling views
// (the sidebar's recent projects, the home list) that the list changed.
import { projects } from "../../store.ts";
import type * as API from "../../api-types.ts";
import { api } from "./api.ts";

const changed = new EventTarget();
export const projectsChanged = () => void changed.dispatchEvent(new Event("change"));
export function onProjectsChanged(fn: () => void) {
  changed.addEventListener("change", fn);
  return () => changed.removeEventListener("change", fn);
}

const filesOf = (src: API.SourceFile[]) => {
  const files: Record<string, string | Uint8Array> = Object.create(null); // any file name, incl. "__proto__"
  for (const f of src) files[f.path] = f.encoding === "base64" ? Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0)) : f.data;
  return files;
};

/** A new local project from a template. Resolves to its id. */
export async function createProject(template: string) {
  const t = await api<{ files: API.SourceFile[] }>(`/v1/templates/${template}`);
  const id = crypto.randomUUID().slice(0, 8);
  await projects.put({ id, name: `${template}-${id.slice(0, 4)}`, template, files: filesOf(t.files), deploy: null });
  projectsChanged();
  return id;
}

/** A new local project from the source uploaded with the app's current deploy (CLI or studio). Resolves to its id. */
export async function openDeployed({ name, url }: { name: string; url: string }) {
  const src = await api<{ files: API.SourceFile[] }>(`/v1/apps/${encodeURIComponent(name)}/source`);
  const id = crypto.randomUUID().slice(0, 8);
  // Whoever holds the app's deploy key may have uploaded this source: don't run it until the user says so.
  await projects.put({ id, name, template: "deployed", files: filesOf(src.files), deploy: { name, url }, trusted: false });
  projectsChanged();
  return id;
}
