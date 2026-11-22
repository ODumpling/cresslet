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
  /** Gone back to a change of the stack (the AI builder is told): it, and the later changes set aside. */
  back?: { position: number; title: string; setAside: string[] };
}

/** An open pull request (GET /v1/apps/:name/git/pulls). */
export interface PullRequest {
  number: number;
  url: string;
  title: string;
  review: "approved" | "changes_requested" | "pending";
  checks: "success" | "failure" | "pending" | "none" | "unknown";
}

/** A change of the app's stack (GET /v1/apps/:name/git/stack, server/stack.ts). */
export interface StackChange {
  id: string;
  position: number;
  branch: string;
  sha: string;
  baseSha: string;
  title: string;
  prompt: string;
  author: string | null;
  createdAt: string;
  /** Where its branch is on GitHub: at `sha`, somewhere else (`headSha`), or gone. */
  github: "ok" | "moved" | "gone";
  headSha?: string;
  /** Its pull request's number, once the stack was submitted. */
  pull: number | null;
}
/** A change's pull request GitHub wouldn't close (going back) or reopen (restoring). */
export interface PullError { change: string; position: number; error: string }
/** A change's pull request, as submitting the stack left it (`error`: GitHub refused it, or its description). */
export interface Submitted { change: string; position: number; number?: number; url?: string; created?: boolean; merged?: boolean; error?: string }
export interface Stack {
  id: string;
  name: string;
  baseSha: string;
  /** Bottom first. */
  changes: StackChange[];
  /** Changes gone back from (above the top, bottom first): restorable until a change is built on the top. */
  setAside: StackChange[];
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
 * One project's source control: changes (each builder turn's commit on a branch of its own, stacked: server/stack.ts),
 * sync (one commit of the workspace), pull, and merge-then-deploy. Steps run one at a time.
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

  /** `snap`: files already read (and the revision before), to commit exactly those. */
  async function syncNow(message: string, snap?: { files: GitFile[]; rev: number }): Promise<{ sha: string; changed: boolean; files: GitFile[] }> {
    const s = o.state();
    if (!s) throw new Error("not connected to a repository");
    const rev = snap?.rev ?? revision(); // before the snapshot: a change after it keeps the workspace dirty
    const files = snap?.files ?? await o.files();
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
      headSha: r.sha, dirty: revision() !== rev, mergeParent: undefined, conflicts: undefined, ...(r.changed ? { back: undefined } : {}),
      // A merge of the default branch committed: the branch is on top of that now.
      ...(s.activeBranch === s.defaultBranch ? { baseSha: r.sha } : s.mergeParent ? { baseSha: s.mergeParent } : {}),
    });
    return { ...r, files };
  }

  /**
   * The workspace committed as a new change (server/stack.ts): a branch of its own, cut from the commit it's on. On a
   * stack's top change it goes on top; on any other branch (the default one, a branch of its own) it starts a stack.
   * Finishing a merge, or on a top recorded at another commit than the workspace's, it's committed to the active branch
   * as before. Below a stack's top (409 `not_on_top`), or on a top pushed to on GitHub (409 `moved`): nothing committed,
   * the edits kept.
   */
  /** `submit: false`: a change made on the way somewhere (going back, deploying): the app's auto-submit skips it. */
  async function changeNow(title: string, prompt: string, submit = true): Promise<{
    sha: string; changed: boolean; files: GitFile[]; change?: StackChange; stack?: { id: string; name: string };
    submitted?: { pulls: Submitted[]; error?: string }; joined?: boolean;
  }> {
    const s = o.state();
    if (!s) throw new Error("not connected to a repository");
    if (s.mergeParent) return syncNow(title);
    const rev = revision();
    const files = await o.files();
    let r: { changed: boolean; sha: string; branch?: string; change?: StackChange; stack?: { id: string; name: string }; submitted?: { pulls: Submitted[]; error?: string }; joined?: boolean };
    try {
      r = await post("/stack", { from: s.activeBranch, baseSha: s.headSha, files, title, prompt, ...(submit ? {} : { submit: false }) });
    } catch (e) {
      if (gitCode(e) !== "not_on_stack") throw e; // not_on_top: kept here (the stack has changes above this one)
      return syncNow(title, { files, rev }); // what was read: an edit since stays here
    }
    if (!r.changed || !r.branch) {
      await set({ dirty: revision() !== rev });
      return { sha: r.sha, changed: false, files };
    }
    await set({
      activeBranch: r.branch, headSha: r.sha, dirty: revision() !== rev, back: undefined,
      ...(s.activeBranch === s.defaultBranch ? { baseSha: s.headSha } : {}),
    });
    o.log?.(`committed change ${r.change?.position ?? "?"} of ${r.stack?.name ?? "the stack"}: ${r.branch} @ ${r.sha.slice(0, 7)}`);
    return { sha: r.sha, changed: true, files, change: r.change, stack: r.stack, submitted: r.submitted, joined: r.joined };
  }

  /** Changes made since `rev` would be overwritten: stop instead. */
  const unchangedSince = (rev: number, what: string) => {
    if (revision() !== rev) throw Object.assign(new Error(`the workspace changed while ${what}: nothing was overwritten, try again`), { code: "changed" });
  };

  /**
   * Loads `branch` (at its commit `ref`, when given) into the workspace. `rev`: the change count it must still be at
   * (default: as of now). `before`: run once its files are in hand and nothing changed here, before they're written
   * (a server step that goes with the load); resolves to more state for once it's on it.
   */
  async function pullNow(branch: string, ref = branch, opts: { rev?: number; before?: () => Promise<Partial<ProjectGitState> | void> } = {}) {
    const s = o.state();
    if (!s) throw new Error("not connected to a repository");
    const rev = opts.rev ?? revision();
    const t = await o.api<{ sha: string; files: GitFile[] }>(path(`/tree?ref=${encodeURIComponent(ref)}`));
    unchangedSince(rev, `loading ${branch}`);
    const extra = (await opts.before?.()) ?? {};
    unchangedSince(rev, `loading ${branch}`);
    // Edited while it loaded (npm install, say): those are changes, kept dirty.
    const done = () => set({ activeBranch: branch, headSha: t.sha, dirty: revision() !== rev, mergeParent: undefined, conflicts: undefined, back: undefined, ...extra, ...(branch === s.defaultBranch ? { baseSha: t.sha } : {}) });
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
      await set({ activeBranch: name, baseSha: s.headSha, back: undefined });
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
    /** Files changed in the workspace. */
    markDirty() {
      const s = o.state();
      if (s && !s.dirty) void set({ dirty: true });
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
        if (!(e as { filesWritten?: boolean }).filesWritten) throw e;
        await merging(); // its files are in: the merge is loaded either way
        // A conflicted package.json can't install until it's resolved: expected. Anything else is said.
        if (!r.conflicts.some((p) => /(?:^|\/)package(?:-lock)?\.json$/.test(p))) throw e;
        return r.conflicts;
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
      const r = await post<{ pull: PullRequest; stackErrors?: Submitted[] }>("/pulls", { branch: s.activeBranch, ...(title ? { title } : {}) });
      // A change of a stack: its stack was submitted; what GitHub refused for the rest of it comes along.
      return { ...r.pull, stackErrors: r.stackErrors };
    }),
    /** The workspace's change count (studio/src/views/workspace/engine.ts bumps it). */
    get revision() {
      return revision();
    },
    /** A new branch from the workspace's commit, whatever branch it's on (e.g. to keep changes GitHub moved past). */
    newBranch: (prefix: string, hint: string) => serial(() => branchNow(prefix, hint)),
    /** Commits the workspace to the active branch. 409 `conflict`: it moved on GitHub (pull first). */
    sync: (message: string) => serial(() => syncNow(message)),
    /**
     * Goes back to a change of the stack: changes here are committed first (as a change, set aside with the later
     * ones), the changes above it are set aside (server/stack.ts), and its files are loaded. The next change goes on it.
     */
    goBack: (change: StackChange) => serial(async () => {
      if (o.state()!.dirty) await changeNow("Edits made in the studio", "", false);
      if (o.state()!.dirty) throw Object.assign(new Error("the workspace changed while its changes were pushed: go back again"), { code: "changed" });
      // Its files first: the server sets the later changes aside only once they're in hand and nothing changed here.
      let r!: { change: StackChange; stack: { id: string }; now: string[]; setAside: StackChange[]; pullErrors?: PullError[] };
      const rev = revision();
      await pullNow(change.branch, change.sha, {
        rev,
        before: async () => {
          r = await post("/stack/back", { change: change.id, sha: change.sha });
          // Edited while the server set them aside: put back the ones it did (nothing was built there), keep the edit.
          if (revision() !== rev && r.now.length) {
            await post("/stack/restore", { stack: r.stack.id, only: r.now }).catch(() => {
              throw Object.assign(new Error("the workspace changed while going back, and the changes set aside couldn't be put back: restore them from the stack"), { code: "changed" });
            });
          }
          return { back: { position: r.change.position, title: r.change.title, setAside: r.setAside.map((x) => x.title) } };
        },
      });
      return r;
    }),
    /**
     * Puts a stack's changes set aside back, and loads the top one (`top`, the last set aside). Changes here would be
     * lost: refused (`dirty`) unless `discard`.
     */
    restore: (stack: string, top: StackChange, discard = false) => serial(async () => {
      if (o.state()!.dirty && !discard) throw Object.assign(new Error("this workspace has changes not pushed yet: restoring would replace them"), { code: "dirty" });
      let r!: { change: StackChange; below: StackChange; restored: number; pullErrors?: PullError[] };
      const rev = revision();
      await pullNow(top.branch, top.sha, {
        rev,
        before: async () => {
          r = await post("/stack/restore", { stack, top: top.id, sha: top.sha });
          // Edited while the server restored them: set them aside again (the workspace is still below them), keep the edit.
          if (revision() !== rev) {
            await post("/stack/back", { change: r.below.id, sha: r.below.sha, top: r.change.id, topSha: r.change.sha }).catch(() => {
              throw Object.assign(new Error("the workspace changed while restoring, and the stack couldn't be put back: load its top change"), { code: "changed" });
            });
          }
        },
      });
      return r;
    }),
    /** Opens or updates a pull request per change of a stack, each on the branch below (server/stack.ts). */
    submitStack: (stack: string) => post<{ pulls: Submitted[] }>("/stack/submit", { stack }),
    /** The review and checks of a stack's pull requests, by change id. */
    stackPulls: (stack: string) => o.api<{ pulls: Record<string, PullRequest> }>(path(`/stack/pulls?stack=${encodeURIComponent(stack)}`)).then((r) => r.pulls),
    /**
     * A change whose branch was pushed to on GitHub (`change.headSha`): pulled in as the top of its stack (`pull-in`), or
     * carried on from as a branch of its own (`carry-on`); either way its branch is loaded as GitHub has it. Changes
     * here would be lost: refused (`dirty`) unless `discard`.
     */
    takeOutside: (how: "pull-in" | "carry-on", change: StackChange, discard = false) => serial(async () => {
      if (!change.headSha) throw new Error(`${change.branch} wasn't pushed to on GitHub`);
      if (o.state()!.dirty && !discard) throw Object.assign(new Error("this workspace has changes not pushed yet: loading the branch would replace them"), { code: "dirty" });
      const rev = revision();
      let r: { pullErrors?: PullError[] } = {};
      await pullNow(change.branch, change.headSha, { rev, before: async () => void (r = await post(`/stack/${how}`, { change: change.id, sha: change.headSha })) });
      return r;
    }),
    /**
     * Lands a change and the ones below it into the default branch (server/stack.ts landUpTo). When the change the
     * workspace is on landed, the workspace is on the default branch now (same files: it's at that commit).
     */
    land: (change: StackChange, top: string) => serial(async () => {
      const r = await post<{ landed: StackChange[]; sha: string; pullErrors?: PullError[] }>("/stack/land", { change: change.id });
      const s = o.state();
      if (s && r.landed.some((c) => c.branch === s.activeBranch) && s.headSha === r.sha) await set({ activeBranch: s.defaultBranch, baseSha: r.sha, headSha: r.sha, back: undefined });
      // On the stack's top, above what landed: the default branch's commit it sits on is the landed one now (not "moved
      // on GitHub").
      else if (s && s.activeBranch === top && !r.landed.some((c) => c.branch === top)) await set({ baseSha: r.sha });
      return r;
    }),
    /** Every change set aside (Source control lists them), and deleting one (with the ones set aside above it). */
    setAside: () => o.api<{ changes: (StackChange & { stackName: string; restorable: boolean })[] }>(path("/stack/aside")).then((r) => r.changes),
    deleteSetAside: (change: string) => post<{ dropped: string[]; kept: PullError[] }>("/stack/aside/delete", { change }),
    /** Resolves once the steps queued so far have run (the AI builder sends a request on the workspace they leave). */
    idle: () => serial(async () => {}),
    /** Commits the workspace as a new change of the app's stack (see changeNow). */
    commitChange: (title: string, prompt = "") => serial(() => changeNow(title, prompt)),
    /** The app's open stacks, newest first, and the one the workspace is on (its active branch is one of its changes). */
    stacks: async () => {
      const r = await o.api<{ defaultBranch: string; stacks: Stack[] }>(path("/stack"));
      const b = o.state()?.activeBranch;
      return { ...r, current: r.stacks.find((x) => x.changes.some((c) => c.branch === b)) ?? null };
    },
    /** Loads a branch (default: the active one) into the workspace. Changes here are lost: sync first. */
    pull: (branch?: string) => serial(() => pullNow(branch ?? o.state()!.activeBranch)),
    /** Changes committed to the active branch (if any), then another branch loaded. */
    switchTo: (branch: string) => serial(async () => {
      // Edits on the default branch go on a branch of their own (it takes changes only through Deploy's merge).
      if (o.state()!.dirty && o.state()!.activeBranch === o.state()!.defaultBranch) await branchNow("edit", "changes");
      if (o.state()!.dirty) {
        try {
          await syncNow(`Work in progress on ${o.state()!.activeBranch}`);
        } catch (e) {
          // On a change below its stack's top (one was added in another browser), or set aside: they go on a branch of
          // their own.
          if (gitCode(e) !== "not_on_top" && gitCode(e) !== "set_aside") throw e;
          await branchNow("keep", o.state()!.activeBranch);
          await syncNow(`Work in progress on ${o.state()!.activeBranch}`);
        }
      }
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
    /** `builder.running`: the deploy was asked for by one of the AI builder's commands (as opposed to by hand). */
    prepareDeploy: (log: (line: string) => void = () => {}, signal?: AbortSignal, builder?: { turn: () => { title: string; prompt: string } | null; running: () => boolean }) => serial(async (): Promise<Provenance> => {
      signal?.throwIfAborted();
      // The AI builder's request, as of now (this step may have waited for others): a deploy from one of its commands
      // commits it as its change; any other waits (deployed now, its edits would go into the change before).
      const turn = builder?.turn() ?? null;
      if (turn && !builder!.running()) throw new Error("the AI builder is working on a request: deploy once it's done");
      // Changes here that are a change of their own first, merged like any other: an AI builder turn's (it's deploying
      // mid-turn), or edits on the default branch (by hand).
      const was = o.state()!;
      let synced: { sha: string; files: GitFile[] } | undefined;
      if (was.dirty && !was.mergeParent && (turn || was.activeBranch === was.defaultBranch)) {
        log(`committing the changes here as a change…`);
        const rev0 = revision();
        synced = await changeNow(turn?.title ?? "Edits made in the studio", turn?.prompt ?? "", false);
        // An edit made meanwhile isn't in that change: it stays here, unpushed (not synced on its own, onto main).
        unchangedSince(rev0, "deploying");
        signal?.throwIfAborted();
      }
      const s = o.state()!;
      const repo = `${s.owner}/${s.repo}`;
      const rev = revision();
      if (!synced) {
        log(`syncing ${s.activeBranch} with ${repo}…`);
        synced = await syncNow(`Deploy from ${s.activeBranch}`);
      }
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
          if ((e as { filesWritten?: boolean }).filesWritten) await set({ activeBranch: s.defaultBranch, baseSha: m.mergedSha, headSha: m.mergedSha, dirty: revision() !== rev, back: undefined });
          throw e;
        }
      }
      await set({ activeBranch: s.defaultBranch, baseSha: m.mergedSha, headSha: m.mergedSha, dirty: revision() !== rev, back: undefined });
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
