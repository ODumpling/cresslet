// Local projects (IndexedDB, store.ts): making one from a template or a deployed app (its repository, or its deployed
// source), and telling views (the sidebar's recent projects, the home list) that the list changed.
import { projects } from "../../store.ts";
import type * as API from "../../api-types.ts";
import type { ProjectGitState } from "../../git.ts";
import { api, errorMessage } from "./api.ts";
import { toast } from "./toast.tsx";

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

/**
 * A new local project of a deployed app, ready to work on: it runs as soon as it opens (npm install, the dev server).
 * Linked to a repository: the default branch's files, with the workspace on that branch (source control from the
 * start); otherwise, or when the repository can't be read as this user (GitHub not connected), the source uploaded
 * with the app's current deploy (CLI or studio). Resolves to its id.
 */
export async function openDeployed({ name, url }: { name: string; url: string }) {
  const id = crypto.randomUUID().slice(0, 8);
  let repoError: unknown;
  const linked = await fromRepository(name).catch((e) => (repoError = e, null));
  let files = linked?.files;
  if (!files) {
    try {
      files = (await api<{ files: API.SourceFile[] }>(`/v1/apps/${encodeURIComponent(name)}/source`)).files;
    } catch (e) {
      throw repoError ?? e; // no deployed source either: why the repository couldn't be read is the error that matters
    }
    // Linked, but its repository couldn't be read as this user: said, not silently worked around.
    if (repoError) toast(`Couldn't load ${name}'s repository (${errorMessage(repoError)}): opened its deployed source instead. Source control can load it once that's fixed.`, 12000);
  }
  await projects.put({ id, name, template: "deployed", files: filesOf(files), deploy: { name, url }, ...(linked ? { git: linked.git } : {}) });
  projectsChanged();
  return id;
}

/** The app's repository's default branch, as a workspace starts on it; null when the app isn't linked. */
async function fromRepository(name: string): Promise<{ files: API.SourceFile[]; git: ProjectGitState } | null> {
  const app = encodeURIComponent(name);
  const { repo } = await api<API.AppDetail>(`/v1/apps/${app}`);
  if (!repo) return null;
  // No ref: the default branch as GitHub has it now (it may have changed since the link), and the repository as it is
  // now (renamed, its new name: what deploys record).
  const t = await api<{ ref: string; sha: string; files: API.SourceFile[]; repo: API.AppRepo }>(`/v1/apps/${app}/git/tree`);
  return {
    files: t.files,
    git: {
      provider: t.repo.provider, owner: t.repo.owner, repo: t.repo.name, url: t.repo.url, defaultBranch: t.ref,
      activeBranch: t.ref, baseSha: t.sha, headSha: t.sha, dirty: false,
    },
  };
}
