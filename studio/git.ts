// Source control in the studio (docs/architecture.md#source-control): a project whose app is linked to a GitHub
// repository works on a branch. The repository is only ever reached through this server's /v1/apps/:name/git/*
// (server/git.ts), as the signed-in user: no GitHub token is in this browser, and there's no git in the container.
// No DOM here: the workspace (src/views/workspace) wires it to the container, and tests/builder_test.ts runs it
// under node with a fake API.

/** A project's link to its repository, kept with the project (IndexedDB). No tokens. */
export interface ProjectGitState {
  provider: "github";
  owner: string;
  repo: string;
  /** The repository's page (links: commits, compare). */
  url: string;
  defaultBranch: string;
  /** The branch the workspace is on. */
  activeBranch: string;
  /** The default branch's commit the active branch was cut from (or the default branch's, on it). */
  baseSha: string;
  /** The active branch's commit the workspace matches (plus `dirty` changes). */
  headSha: string;
  /** Files changed here since `headSha`. */
  dirty: boolean;
}

/** A file as the API takes and returns them (POST /v1/deploys's shape). */
export interface GitFile {
  path: string;
  data: string;
  encoding?: "utf8" | "base64";
}

/** The API, as the studio calls it (src/lib/api.ts), errors with `status` and the body's `error` code. */
export type GitApi = <T>(path: string, init?: { method?: string; body?: string }) => Promise<T>;
export type GitError = Error & { status?: number; code?: string; body?: Record<string, unknown> };
export const gitCode = (e: unknown) => (e as GitError | null)?.code;

/** A branch name from a prompt or a file: `feat/add-a-dark-mode`, lowercase words, at most 40 characters. */
export function branchSlug(text: string, max = 40): string {
  const words = text.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, " ").split(/[\s_-]+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || words[0]?.slice(0, max) || "change";
}

/** A one-line commit message from a prompt. */
export function commitMessage(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]!.trim() || "Update"; // split always yields one
  return line.length > 72 ? line.slice(0, 71) + "…" : line;
}

export interface GitWorkspaceOptions {
  app: () => string | undefined;
  api: GitApi;
  state: () => ProjectGitState | undefined;
  /** Store the new state with the project. */
  save: (s: ProjectGitState | undefined) => Promise<void> | void;
  /** The workspace's project source, filtered as for a deploy (no local secrets). */
  files: () => Promise<GitFile[]>;
  /** Make the workspace hold these files (a pull, or a merge that brought the default branch's commits). */
  hydrate: (files: GitFile[]) => Promise<void>;
  log?: (line: string) => void;
}

/** What a deploy was built from (POST /v1/deploys `git`). */
export interface Provenance {
  sha: string;
  branch: string;
  repo: string;
}

/**
 * One project's source control: branch first (a change on the default branch moves to a new branch), sync (one commit
 * of the workspace), pull, and merge-then-deploy. Steps run one at a time.
 */
export function createGitWorkspace(o: GitWorkspaceOptions) {
  let queue: Promise<unknown> = Promise.resolve();
  /** One step at a time (a sync and a branch switch never interleave). */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };
  const path = (rest: string) => `/v1/apps/${encodeURIComponent(o.app() ?? "")}/git${rest}`;
  const post = <T>(rest: string, body: unknown) => o.api<T>(path(rest), { method: "POST", body: JSON.stringify(body) });
  const set = async (patch: Partial<ProjectGitState>) => {
    const s = o.state();
    if (s) await o.save({ ...s, ...patch });
  };

  async function syncNow(message: string): Promise<{ sha: string; changed: boolean }> {
    const s = o.state();
    if (!s) throw new Error("not connected to a repository");
    const r = await post<{ sha: string; changed: boolean }>("/sync", { branch: s.activeBranch, baseSha: s.headSha, files: await o.files(), message });
    await set({ headSha: r.sha, dirty: false, ...(s.activeBranch === s.defaultBranch ? { baseSha: r.sha } : {}) });
    return r;
  }

  async function pullNow(branch: string) {
    const s = o.state();
    if (!s) throw new Error("not connected to a repository");
    const t = await o.api<{ sha: string; files: GitFile[] }>(path(`/tree?ref=${encodeURIComponent(branch)}`));
    await o.hydrate(t.files);
    await set({ activeBranch: branch, headSha: t.sha, dirty: false, ...(branch === s.defaultBranch ? { baseSha: t.sha } : {}) });
    return t.sha;
  }

  /** A new branch from the workspace's commit, named after `hint` (`-2`, `-3`… if taken). */
  async function branchNow(prefix: string, hint: string): Promise<string> {
    const s = o.state()!;
    const base = `${prefix}/${branchSlug(hint)}`;
    for (let i = 1; i <= 20; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      try {
        await post("/branches", { name, from: s.headSha });
      } catch (e) {
        if (gitCode(e) === "branch_exists") continue;
        throw e;
      }
      await set({ activeBranch: name, baseSha: s.headSha });
      o.log?.(`working on branch ${name} (from ${s.activeBranch} @ ${s.headSha.slice(0, 7)})`);
      return name;
    }
    throw new Error(`couldn't find a free branch name like ${base}`);
  }

  return {
    get state() {
      return o.state();
    },
    get connected() {
      return !!o.state() && !!o.app();
    },
    /** On the default branch (where changes shouldn't go straight). */
    get onDefault() {
      const s = o.state();
      return !!s && s.activeBranch === s.defaultBranch;
    },
    /** Files changed in the workspace. */
    markDirty() {
      const s = o.state();
      if (s && !s.dirty) void set({ dirty: true });
    },
    /**
     * Branch first: on the default branch, moves the workspace to a new branch (`feat/<hint>`) before it changes.
     * Resolves to the branch created, or null when already on another branch (or not connected).
     */
    ensureBranch(prefix: string, hint: string): Promise<string | null> {
      return serial(async () => (this.connected && this.onDefault ? branchNow(prefix, hint) : null));
    },
    /** Linked (the repository's state as the connect call answered), or unlinked (undefined). */
    attach: (st: ProjectGitState | undefined) => serial(async () => o.save(st)),
    /** A new branch from the workspace's commit, whatever branch it's on (e.g. to keep changes GitHub moved past). */
    newBranch: (prefix: string, hint: string) => serial(() => branchNow(prefix, hint)),
    /** Commits the workspace to the active branch. 409 `conflict`: it moved on GitHub (pull first). */
    sync: (message: string) => serial(() => syncNow(message)),
    /** Loads a branch (default: the active one) into the workspace. Changes here are lost: sync first. */
    pull: (branch?: string) => serial(() => pullNow(branch ?? o.state()!.activeBranch)),
    /** Changes committed to the active branch (if any), then another branch loaded. */
    switchTo: (branch: string) => serial(async () => {
      if (o.state()!.dirty) await syncNow(`Work in progress on ${o.state()!.activeBranch}`);
      return pullNow(branch);
    }),
    /**
     * Deploy = merge into the default branch, then deploy it: commits the workspace to its branch, merges that into
     * the default branch (on it already: just the commit), loads the merged files when the default branch had commits
     * of its own, and resolves to the commit to build and record. Throws, before anything is built, on a conflict
     * or a protected branch.
     */
    prepareDeploy: (log: (line: string) => void = () => {}) => serial(async (): Promise<Provenance> => {
      const s = o.state()!;
      const repo = `${s.owner}/${s.repo}`;
      log(`syncing ${s.activeBranch} with ${repo}…`);
      const synced = await syncNow(`Deploy from ${s.activeBranch}`);
      if (s.activeBranch === s.defaultBranch) return { sha: synced.sha, branch: s.defaultBranch, repo };
      log(`merging ${s.activeBranch} into ${s.defaultBranch}…`);
      let m: { mergedSha: string; fastForward: boolean; treeChanged: boolean; files?: GitFile[]; filesError?: string };
      try {
        m = await post("/merge", { branch: s.activeBranch });
      } catch (e) {
        const code = gitCode(e);
        const compare = `${s.url}/compare/${encodeURIComponent(s.defaultBranch)}...${encodeURIComponent(s.activeBranch)}?expand=1`;
        if (code === "merge_conflict") {
          const paths = ((e as GitError).body?.paths as string[] | undefined) ?? [];
          throw Object.assign(new Error(`${s.activeBranch} doesn't merge cleanly into ${s.defaultBranch}${paths.length ? ` (${paths.join(", ")})` : ""}. Nothing was deployed. Resolve it in a pull request: ${compare}`), { code, compare, paths });
        }
        if (code === "branch_protected" || (e as GitError).status === 403) {
          throw Object.assign(new Error(`${s.defaultBranch} is protected on GitHub (it needs a pull request or checks). Nothing was deployed. Open a pull request: ${compare}`), { code: "branch_protected", compare });
        }
        throw e;
      }
      if (m.treeChanged) {
        // Merged, but its files didn't come back: this workspace isn't what was merged, so it isn't built (or
        // pushed over the default branch). It stays on the branch, which GitHub kept.
        if (!m.files) throw new Error(`Merged ${s.activeBranch} into ${s.defaultBranch}, but couldn't load the result (${m.filesError ?? "no files"}). Nothing was deployed.`);
        log(`${s.defaultBranch} had commits of its own: loading the merged files…`);
        await o.hydrate(m.files);
      }
      await set({ activeBranch: s.defaultBranch, baseSha: m.mergedSha, headSha: m.mergedSha, dirty: false });
      log(`merged into ${s.defaultBranch} @ ${m.mergedSha.slice(0, 7)}${m.fastForward ? " (fast-forward)" : ""}`);
      return { sha: m.mergedSha, branch: s.defaultBranch, repo };
    }),
  };
}
export type GitWorkspace = ReturnType<typeof createGitWorkspace>;
