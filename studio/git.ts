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
  /**
   * Resolving a merge of the default branch into this one (its head then): committed as the second parent, and the
   * files that conflicted (they hold `<<<<<<<` markers until resolved).
   */
  mergeParent?: string;
  conflicts?: string[];
}

/** An open pull request (GET /v1/apps/:name/git/pulls). */
export interface PullRequest {
  number: number;
  url: string;
  title: string;
  review: "approved" | "changes_requested" | "pending";
  checks: "success" | "failure" | "pending" | "none" | "unknown";
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
  /**
   * Make the workspace hold these files (a pull, or a merge that brought the default branch's commits). An error with
   * `filesWritten: true` means the files are in place and only a later step (npm install) failed.
   */
  hydrate: (files: GitFile[]) => Promise<void>;
  /** Counts the workspace's changes (each file change bumps it): a sync is clean only if none came in meanwhile. */
  revision?: () => number;
  log?: (line: string) => void;
}

/** What a deploy was built from (POST /v1/deploys `git`), and that commit's files (to check the upload against). */
export interface Provenance {
  sha: string;
  branch: string;
  repo: string;
  files: GitFile[];
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

  const revision = () => o.revision?.() ?? 0;

  async function syncNow(message: string): Promise<{ sha: string; changed: boolean; files: GitFile[] }> {
    const s = o.state();
    if (!s) throw new Error("not connected to a repository");
    const rev = revision(); // before the snapshot: a change after it keeps the workspace dirty
    const files = await o.files();
    // A merge being resolved: not committed while a conflicted file still has its markers.
    const left = (s.conflicts ?? []).filter((p) => files.some((f) => f.path === p && f.encoding !== "base64" && /^(?:<<<<<<<|>>>>>>>) /m.test(f.data)));
    if (left.length) throw Object.assign(new Error(`resolve the merge conflicts first (markers left in ${left.join(", ")})`), { code: "conflicts_left" });
    let r: { sha: string; changed: boolean };
    try {
      r = await post<{ sha: string; changed: boolean }>("/sync", {
        branch: s.activeBranch, baseSha: s.headSha, files, message, ...(s.mergeParent ? { mergeParent: s.mergeParent } : {}),
      });
    } catch (e) {
      if (gitCode(e) === "branch_not_found") {
        throw Object.assign(new Error(`${s.activeBranch} is gone on GitHub (merged and deleted?). Switch to ${s.defaultBranch} in Source control, or push these changes to a new branch.`), { code: "branch_not_found" });
      }
      throw e;
    }
    await set({
      headSha: r.sha, dirty: revision() !== rev, mergeParent: undefined, conflicts: undefined,
      // A merge of the default branch committed: the branch is on top of that now.
      ...(s.activeBranch === s.defaultBranch ? { baseSha: r.sha } : s.mergeParent ? { baseSha: s.mergeParent } : {}),
    });
    return { ...r, files };
  }

  /** Changes made since `rev` would be overwritten: stop instead. */
  const unchangedSince = (rev: number, what: string) => {
    if (revision() !== rev) throw Object.assign(new Error(`the workspace changed while ${what}: nothing was overwritten, try again`), { code: "changed" });
  };

  async function pullNow(branch: string) {
    const s = o.state();
    if (!s) throw new Error("not connected to a repository");
    const rev = revision();
    const t = await o.api<{ sha: string; files: GitFile[] }>(path(`/tree?ref=${encodeURIComponent(branch)}`));
    unchangedSince(rev, `loading ${branch}`);
    // Edited while it loaded (npm install, say): those are changes, kept dirty.
    const done = () => set({ activeBranch: branch, headSha: t.sha, dirty: revision() !== rev, mergeParent: undefined, conflicts: undefined, ...(branch === s.defaultBranch ? { baseSha: t.sha } : {}) });
    try {
      await o.hydrate(t.files);
    } catch (e) {
      if ((e as { filesWritten?: boolean }).filesWritten) await done(); // its files are in: the workspace is on it
      throw e;
    }
    await done();
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
    /**
     * The app is linked (elsewhere: another browser, the CLI) but this workspace isn't: links it and loads the default
     * branch, replacing the files here.
     */
    adopt: (repo: { provider: "github"; owner: string; name: string; url: string; defaultBranch: string }) => serial(async () => {
      await o.save({
        provider: repo.provider, owner: repo.owner, repo: repo.name, url: repo.url, defaultBranch: repo.defaultBranch,
        activeBranch: repo.defaultBranch, baseSha: "", headSha: "", dirty: false,
      });
      try {
        return await pullNow(repo.defaultBranch);
      } catch (e) {
        if (!(e as { filesWritten?: boolean }).filesWritten) await o.save(undefined); // not loaded: not linked here either
        throw e;
      }
    }),
    /**
     * The default branch merged into this branch here, for its conflicts to be resolved (by hand or by the AI
     * builder): the merged files are loaded, conflicted ones with markers. The next sync commits the merge.
     * Resolves to the conflicted paths.
     */
    resolveConflicts: () => serial(async () => {
      const s = o.state()!;
      if (s.dirty) await syncNow(`Work in progress on ${s.activeBranch}`);
      if (o.state()!.dirty) throw Object.assign(new Error("the workspace changed while its changes were pushed: try again"), { code: "changed" });
      const rev = revision();
      const r = await o.api<{ intoSha: string; headSha: string; conflicts: string[]; files: GitFile[] }>(path(`/conflicts?branch=${encodeURIComponent(s.activeBranch)}`));
      unchangedSince(rev, "loading the merge"); // not over an edit made meanwhile
      const merging = () => set({ headSha: r.headSha, mergeParent: r.intoSha, conflicts: r.conflicts, dirty: true });
      try {
        await o.hydrate(r.files);
      } catch (e) {
        // A conflicted package.json fails npm install: the merge is still loaded, to resolve.
        if (!(e as { filesWritten?: boolean }).filesWritten) throw e;
      }
      await merging();
      return r.conflicts;
    }),
    /** The active branch's open pull request, if any. */
    pullRequest: () => o.api<{ pull: PullRequest | null }>(path(`/pulls?branch=${encodeURIComponent(o.state()!.activeBranch)}`)).then((r) => r.pull),
    /** Opens (or finds) the active branch's pull request, its changes pushed first. */
    openPullRequest: (title?: string) => serial(async () => {
      const s = o.state()!;
      if (s.dirty) await syncNow(`Update ${s.activeBranch}`);
      return (await post<{ pull: PullRequest }>("/pulls", { branch: s.activeBranch, ...(title ? { title } : {}) })).pull;
    }),
    /** The workspace's change count (studio/src/views/workspace/engine.ts bumps it). */
    get revision() {
      return revision();
    },
    /** A new branch from the workspace's commit, whatever branch it's on (e.g. to keep changes GitHub moved past). */
    newBranch: (prefix: string, hint: string) => serial(() => branchNow(prefix, hint)),
    /** Commits the workspace to the active branch. 409 `conflict`: it moved on GitHub (pull first). */
    sync: (message: string) => serial(() => syncNow(message)),
    /** Loads a branch (default: the active one) into the workspace. Changes here are lost: sync first. */
    pull: (branch?: string) => serial(() => pullNow(branch ?? o.state()!.activeBranch)),
    /** Changes committed to the active branch (if any), then another branch loaded. */
    switchTo: (branch: string) => serial(async () => {
      if (o.state()!.dirty) await syncNow(`Work in progress on ${o.state()!.activeBranch}`);
      if (o.state()!.dirty) throw Object.assign(new Error("the workspace changed while its changes were pushed: switch again"), { code: "changed" });
      return pullNow(branch);
    }),
    /** Another branch loaded, this workspace's changes dropped (its branch is gone, say). */
    discardAndSwitch: (branch: string) => serial(() => pullNow(branch)),
    /**
     * Deploy = merge into the default branch, then deploy it: commits the workspace to its branch, merges that into
     * the default branch (on it already: just the commit), loads the merged files when the default branch had commits
     * of its own, and resolves to the commit to build and record. Throws, before anything is built, on a conflict
     * or a protected branch.
     */
    prepareDeploy: (log: (line: string) => void = () => {}, signal?: AbortSignal) => serial(async (): Promise<Provenance> => {
      const s = o.state()!;
      const repo = `${s.owner}/${s.repo}`;
      signal?.throwIfAborted();
      log(`syncing ${s.activeBranch} with ${repo}…`);
      const rev = revision();
      const synced = await syncNow(`Deploy from ${s.activeBranch}`);
      // What's built must be what was committed: a change made since stops the deploy (it stays, unpushed).
      unchangedSince(rev, "deploying");
      if (s.activeBranch === s.defaultBranch) return { sha: synced.sha, branch: s.defaultBranch, repo, files: synced.files };
      signal?.throwIfAborted(); // stopped: nothing merged
      log(`merging ${s.activeBranch} into ${s.defaultBranch}…`);
      let m: { mergedSha: string; fastForward: boolean; treeChanged: boolean; files?: GitFile[]; filesError?: string };
      try {
        // Exactly what was synced: a push to the branch since then is a conflict, not merged unseen.
        m = await post("/merge", { branch: s.activeBranch, headSha: synced.sha });
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
        unchangedSince(rev, "deploying");
        // Merged, but its files didn't come back: this workspace isn't what was merged, so it isn't built (or
        // pushed over the default branch). It stays on the branch, which GitHub kept.
        if (!m.files) throw new Error(`Merged ${s.activeBranch} into ${s.defaultBranch}, but couldn't load the result (${m.filesError ?? "no files"}). Nothing was deployed.`);
        log(`${s.defaultBranch} had commits of its own: loading the merged files…`);
        try {
          await o.hydrate(m.files);
        } catch (e) {
          // The files are main's now (only installing failed): the workspace is on main, at the merge.
          if ((e as { filesWritten?: boolean }).filesWritten) await set({ activeBranch: s.defaultBranch, baseSha: m.mergedSha, headSha: m.mergedSha, dirty: revision() !== rev });
          throw e;
        }
      }
      await set({ activeBranch: s.defaultBranch, baseSha: m.mergedSha, headSha: m.mergedSha, dirty: revision() !== rev });
      log(`merged into ${s.defaultBranch} @ ${m.mergedSha.slice(0, 7)}${m.fastForward ? " (fast-forward)" : ""}`);
      // The files built must be the commit's (the plugin checks the upload): what was synced, or the merge's own. If
      // npm install rewrote its lockfile, they aren't: that deploy stops, and the change is pushed with the next one.
      const files = m.treeChanged ? m.files! : synced.files;
      unchangedSince(rev, "deploying");
      return { sha: m.mergedSha, branch: s.defaultBranch, repo, files };
    }),
  };
}
export type GitWorkspace = ReturnType<typeof createGitWorkspace>;
