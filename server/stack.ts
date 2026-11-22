// Stacked changes (docs/architecture.md#stacked-changes): on a linked app, each AI builder turn that changes files is
// a change: a branch of its own, cut from the commit the workspace was on, holding that turn's commit. The changes
// since the default branch, in order, are a stack. The server records them (store.stack_changes) so every browser
// and collaborator sees the same stack; GitHub stays the authority for where the branches point (readStacks says
// when one moved or is gone). Routes are with the other git routes (server/git.ts); this takes the provider and the
// store, so it's tested without a network (tests/stack_test.ts).
import { HttpError } from "./deploys.ts";
import { type Author, type Pull, type PullInfo, pool, type Repo, type SourceControlProvider } from "./git.ts";
import { type AppRepo, id, type StackChange, type Store } from "./store.ts";

/** A branch name part from a title: lowercase words, at most `max` characters (as the studio's branchSlug). */
export function slug(text: string, max = 30): string {
  const words = text.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, " ").split(/[\s_-]+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || words[0]?.slice(0, max) || "change";
}

/** A change as the API shows it. `github`: where its branch is on GitHub now (`moved`: not at `sha`). */
export interface ChangeView {
  id: string;
  position: number;
  branch: string;
  sha: string;
  baseSha: string;
  title: string;
  prompt: string;
  author: string | null;
  createdAt: string;
  github: "ok" | "moved" | "gone";
  /** The branch's head on GitHub, when it moved. */
  headSha?: string;
  /** Its pull request's number, once the stack was submitted. */
  pull: number | null;
}
export interface StackView {
  id: string;
  name: string;
  /** The commit the bottom change was cut from (the default branch's, or a branch of its own's). */
  baseSha: string;
  /** Bottom first: the top change (the last) holds them all. */
  changes: ChangeView[];
  /** Changes above the top that were gone back from (bottom first): restorable until a change is built on the top. */
  setAside: ChangeView[];
}

const view = (c: StackChange): Omit<ChangeView, "github"> => ({
  id: c.id, position: c.position, branch: c.branch, sha: c.sha, baseSha: c.base_sha, title: c.title, prompt: c.prompt,
  author: c.author, createdAt: new Date(c.created_at).toISOString(), pull: c.pr_number ?? null,
});

/** Open changes by stack, each bottom first; stacks oldest first. */
function byStack(changes: StackChange[]) {
  const out = new Map<string, StackChange[]>();
  for (const c of changes) out.set(c.stack_id, [...(out.get(c.stack_id) ?? []), c]);
  for (const list of out.values()) list.sort((x, y) => x.position - y.position);
  return [...out.values()];
}

/** One change at a time per app in this process (another server racing it loses on the stack's unique position). */
const locks = new Map<string, Promise<unknown>>();
export function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = p.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => locks.get(key) === tail && locks.delete(key));
  return p;
}

export interface Ctx {
  provider: SourceControlProvider;
  store: Store;
  appId: string;
  repo: AppRepo;
  r: Repo;
}

const notOnStack = (message: string) => new HttpError(409, message, "not_on_stack");

/** A stack's most changes: at it, a turn joins the top change instead (land the stack to start new ones). */
export const MAX_STACK = 30;
const setAside = (c: StackChange) => new HttpError(
  409, `${c.branch} (change ${c.position} of ${c.stack_name}) was set aside: going back left it out of the stack. Restore it, or load the stack's top`, "set_aside",
);
const notOnTop = (c: StackChange, top: StackChange) => new HttpError(
  409, `${c.branch} is change ${c.position} of ${c.stack_name}, below its top (${top.branch}, added since): load the top change first`, "not_on_top",
);

/**
 * Commits the workspace as a new change. `from`: the branch the workspace is on, at `baseSha`. On a change set aside,
 * 409 `set_aside`. On the top change of
 * an open stack it goes on top; on any other branch that isn't one of a stack's changes (the default branch, a
 * branch of its own) it starts a new stack from there. On a change below a stack's top, 409 `not_on_top`; on a top
 * change recorded at another commit than `baseSha`, 409 `not_on_stack` (the caller commits to its branch as before).
 * Nothing changed: no branch, no change.
 */
export function commitChange(ctx: Ctx, input: {
  from: string; baseSha: string; files: [string, Uint8Array][]; title: string; prompt: string; author: Author; by: string | null;
}): Promise<{ changed: false; sha: string } | { changed: true; sha: string; branch: string; change: ChangeView; stack: { id: string; name: string }; joined?: boolean }> {
  const { provider, store, appId, repo, r } = ctx;
  return locked(appId, async () => {
    const stacks = byStack(await store.openStackChanges(appId));
    let below: StackChange | undefined, topHead: string | null = null;
    const aside = input.from === repo.default_branch ? undefined : (await store.setAsideStackChanges(appId)).find((c) => c.branch === input.from);
    if (aside) throw setAside(aside);
    const on = input.from === repo.default_branch ? undefined : stacks.find((s) => s.some((c) => c.branch === input.from));
    if (on) {
      const top = on.at(-1)!; // a stack listed has a change
      if (top.branch !== input.from) throw notOnTop(on.find((c) => c.branch === input.from)!, top);
      // Pushed to on GitHub since (first: a workspace that pulled that push is on it too): a change on the old commit
      // would leave it out, a commit onto the branch would leave the stack behind. The stack says what to do.
      // (Deleted there: its commit is still the one to build on.)
      topHead = await provider.branchHead(r, top.branch);
      if (topHead && topHead !== top.sha) {
        throw new HttpError(409, `${top.branch} was pushed to on GitHub: pull it in, or carry on from it, from the stack (your changes are kept here)`, "moved");
      }
      if (top.sha !== input.baseSha) throw notOnStack(`${input.from} is recorded at another commit than the workspace's`);
      below = top;
    } else if (input.from !== repo.default_branch && (await store.stackChangesInState(appId, "outside")).some((c) => c.branch === input.from)) {
      // Carried on from as a branch of its own (pushed to on GitHub): committed to as one branch, as before stacks.
      throw notOnStack(`${input.from} left its stack (changed on GitHub): it's committed to as a branch of its own`);
    }
    // At the limit: this turn joins the top change (its branch gets the commit), and the user is told.
    if (below && on!.length >= MAX_STACK) {
      // (Its branch deleted on GitHub: made again, at this commit.)
      const out = await provider.commitTree(r, {
        branch: below.branch, baseSha: input.baseSha, subdir: repo.subdir, files: input.files, message: input.title, author: input.author, create: !topHead,
      });
      if (!out.changed) return { changed: false, sha: input.baseSha };
      await followed(ctx, below.branch, input.baseSha, out.sha);
      return {
        changed: true, sha: out.sha, branch: below.branch, joined: true,
        change: { ...view({ ...below, sha: out.sha }), github: "ok" }, stack: { id: below.stack_id, name: below.stack_name },
      };
    }
    const position = below ? below.position + 1 : 1;
    const part = `${position}-${slug(input.title)}`;
    // The stack's name: the first change's title, unless an open stack (or a branch in the way) has it.
    const names = new Set(stacks.map((s) => s[0].stack_name));
    const candidates: { name: string; branch: string }[] = [];
    for (let i = 1; candidates.length < 20; i++) {
      if (below) candidates.push({ name: below.stack_name, branch: `feat/${below.stack_name}/${i === 1 ? part : `${part}-${i}`}` });
      else {
        const name = i === 1 ? slug(input.title) : `${slug(input.title)}-${i}`;
        if (!names.has(name)) candidates.push({ name, branch: `feat/${name}/${part}` });
      }
    }
    let at = 0, out: { sha: string; changed: boolean };
    try {
      out = await provider.commitTree(r, {
        branch: candidates[0].branch, create: true, baseSha: input.baseSha, subdir: repo.subdir, files: input.files,
        message: input.title, author: input.author,
      });
    } catch (e) {
      const sha = (e as HttpError).extra?.sha;
      if (!(e instanceof HttpError) || e.code !== "branch_exists" || typeof sha !== "string") throw e;
      // The commit's made: only its branch needs a free name.
      for (at = 1; ; at++) {
        if (at === candidates.length) throw new HttpError(409, `couldn't find a free branch name like ${candidates[0].branch}`, "branch_exists");
        try {
          await provider.createBranch(r, candidates[at].branch, sha);
          break;
        } catch (e2) {
          if (!(e2 instanceof HttpError) || e2.code !== "branch_exists") throw e2;
        }
      }
      out = { sha, changed: true };
    }
    if (!out.changed) return { changed: false, sha: input.baseSha };
    const { name, branch } = candidates[at];
    let c: StackChange;
    try {
      // Built on a change that was gone back to: the ones set aside above it can't come back (their branches stay).
      // Moved out first (their positions are the new change's), in the same transaction: a failed insert keeps them.
      c = await store.db.tx(async () => {
        if (below) await store.detachSetAside(appId, below.stack_id, id("stk"));
        return store.addStackChange({
          id: id("chg"), app_id: appId, stack_id: below?.stack_id ?? id("stk"), stack_name: name, position, branch,
          sha: out.sha, base_sha: input.baseSha, title: input.title.slice(0, 200), prompt: input.prompt.slice(0, 5000),
          author: input.author.name, created_by: input.by,
        });
      });
    } catch (e) {
      // Another server put a change there first: this one isn't recorded, so its branch goes.
      await provider.deleteBranch(r, branch).catch(() => {});
      console.error(e);
      throw new HttpError(409, "the stack changed meanwhile: try again", "conflict");
    }
    return { changed: true, sha: out.sha, branch, change: { ...view(c), github: "ok" }, stack: { id: c.stack_id, name } };
  });
}

/** The app's open stacks, newest first, with their changes set aside, each change checked against GitHub. */
export async function readStacks(ctx: Ctx): Promise<StackView[]> {
  const stacks = byStack(await ctx.store.openStackChanges(ctx.appId));
  const open = new Set(stacks.map((s) => s[0].stack_id));
  const aside = (await ctx.store.setAsideStackChanges(ctx.appId)).filter((c) => open.has(c.stack_id));
  const all = [...stacks.flat(), ...aside];
  const heads = await pool(all, 8, (c) => ctx.provider.branchHead(ctx.r, c.branch));
  const head = new Map(all.map((c, i) => [c.id, heads[i]]));
  const show = (c: StackChange): ChangeView => {
    const h = head.get(c.id);
    return { ...view(c), ...(h === c.sha ? { github: "ok" as const } : h ? { github: "moved" as const, headSha: h } : { github: "gone" as const }) };
  };
  return stacks.reverse().map((s) => ({
    id: s[0].stack_id, name: s[0].stack_name, baseSha: s[0].base_sha,
    changes: s.map(show),
    setAside: aside.filter((c) => c.stack_id === s[0].stack_id).map(show),
  }));
}

/**
 * Goes back to a change: the open changes above it in its stack are set aside (their branches kept), so it's the top
 * and the next change goes on it. Resolves to the change, for the workspace to load its commit.
 */
const stackChanged = () => new HttpError(409, "the stack changed meanwhile (in another browser?): look at it again", "conflict");

/**
 * Goes back to a change (at `sha`, the commit the caller will load): the open changes above it in its stack are set
 * aside (their branches kept), so it's the top and the next change goes on it. `now`: the ones this set aside;
 * `setAside`: all the stack's, earlier ones too.
 */
export function goBack(ctx: Ctx, changeId: string, sha?: string, top?: { id: string; sha: string }): Promise<{ change: ChangeView; stack: { id: string; name: string }; now: string[]; setAside: ChangeView[]; pullErrors?: PullError[] }> {
  return locked(ctx.appId, async () => {
    const open = await ctx.store.openStackChanges(ctx.appId);
    const c = open.find((x) => x.id === changeId);
    if (!c) throw new HttpError(404, "no such change open on a stack", "not_found");
    if (sha && c.sha !== sha) throw stackChanged();
    // `top`: the stack's top the caller expects (undoing a restore: nothing added on it since).
    const was = byStack(open.filter((x) => x.stack_id === c.stack_id))[0]!.at(-1)!;
    if (top && (was.id !== top.id || was.sha !== top.sha)) throw stackChanged();
    const above = open.filter((x) => x.stack_id === c.stack_id && x.position > c.position);
    await ctx.store.setAsideAbove(ctx.appId, c.stack_id, c.position);
    const aside = (await ctx.store.setAsideStackChanges(ctx.appId)).filter((x) => x.stack_id === c.stack_id);
    // Their pull requests are closed (branches kept): reopened by restore. All the stack's set aside: one that failed
    // to close before is tried again.
    const pullErrors = await setPulls(ctx, aside, "closed");
    return {
      change: { ...view(c), github: "ok" }, stack: { id: c.stack_id, name: c.stack_name }, now: above.map((x) => x.id),
      setAside: aside.map((x) => ({ ...view(x), github: "ok" as const })), ...(pullErrors.length ? { pullErrors } : {}),
    };
  });
}

/**
 * Puts a stack's changes set aside back on it (while nothing was built where they were): all of them, or only `only`
 * (the ones a go back set aside, to undo it). `top`: the change the caller will load, which must be the new top.
 * Resolves to it, and `below`: the top before (to go back to, to undo this).
 */
export function restore(ctx: Ctx, stackId: string, opts: { only?: string[]; top?: { id: string; sha: string } } = {}): Promise<{ change: ChangeView; below: ChangeView; stack: { id: string; name: string }; restored: number; pullErrors?: PullError[] }> {
  return locked(ctx.appId, async () => {
    // A stack that landed (or was forgotten) meanwhile: its changes set aside have no stack to go back on.
    const before = byStack((await ctx.store.openStackChanges(ctx.appId)).filter((c) => c.stack_id === stackId))[0];
    if (!before) throw new HttpError(409, "nothing to restore: that stack isn't open any more", "nothing_set_aside");
    let aside = (await ctx.store.setAsideStackChanges(ctx.appId)).filter((c) => c.stack_id === stackId);
    if (opts.only) {
      // The bottom ones only: the stack stays a straight line (nothing open above one still set aside).
      const want = aside.slice(0, opts.only.length);
      if (want.length !== opts.only.length || want.some((c) => !opts.only!.includes(c.id))) throw stackChanged();
      aside = want;
    }
    if (!aside.length) throw new HttpError(409, "nothing to restore: a change was built where they were, or they're back already", "nothing_set_aside");
    const top = aside.at(-1)!;
    if (opts.top && (top.id !== opts.top.id || top.sha !== opts.top.sha)) throw stackChanged();
    const n = await ctx.store.restoreSetAside(ctx.appId, stackId, aside.map((c) => c.id));
    const pullErrors = await setPulls(ctx, aside, "open");
    return {
      change: { ...view(top), github: "ok" }, below: { ...view(before.at(-1)!), github: "ok" }, stack: { id: top.stack_id, name: top.stack_name },
      restored: n, ...(pullErrors.length ? { pullErrors } : {}),
    };
  });
}

/**
 * A commit Cresslet made onto `branch` from `from` to `to` (a hand edit pushed, a merge resolved): if that's an open
 * stack's top change at `from`, the change follows it. Any commit on a stack's top builds on it: changes set aside above
 * it (it was gone back to) can't come back, since they don't hold the new commit.
 */
export async function followed(ctx: Ctx, branch: string, from: string, to: string) {
  const top = byStack(await ctx.store.openStackChanges(ctx.appId)).map((s) => s.at(-1)!).find((c) => c.branch === branch);
  if (!top) return;
  await ctx.store.db.tx(async () => {
    await ctx.store.followStackTop(ctx.appId, branch, from, to);
    await ctx.store.detachSetAside(ctx.appId, top.stack_id, id("stk"));
  });
}

/**
 * Before `branch` is merged into the default branch, or committed to: a change set aside, or below its stack's top, can't be (merged,
 * its stack would be left open on a branch that's gone; committed to, the changes above wouldn't hold it). Landing
 * part of a stack is a later step; until then the top lands them all.
 */
export async function assertNotBelowTop(ctx: Ctx, branch: string) {
  const aside = (await ctx.store.setAsideStackChanges(ctx.appId)).find((c) => c.branch === branch);
  if (aside) throw setAside(aside);
  for (const s of byStack(await ctx.store.openStackChanges(ctx.appId))) {
    const c = s.find((x) => x.branch === branch), top = s.at(-1)!;
    if (c && c !== top) throw notOnTop(c, top);
  }
}

/**
 * `branch` at `headSha` was merged into the default branch at `mergedSha`. If that's an open change (its stack's top
 * when the merge was allowed; another may have been added on it since), it and the ones below it are in: they're
 * landed, and with `deleteBelow` the stack's landed branches go, the merged one too (dropLanded: the app's
 * delete-branch setting, at their change, not under a pull request still open). A change added on top stays open.
 * One landed already (a merge run again): its stack's branches are looked at again, the same way.
 */
export async function landed(ctx: Ctx, input: { branch: string; headSha: string; mergedSha: string; deleteBelow: boolean }): Promise<{ stack: string; changes: number; deleted: string[]; pullErrors?: PullError[] } | null> {
  let s: StackChange[] = [], top: StackChange | undefined;
  for (const x of byStack(await ctx.store.openStackChanges(ctx.appId))) {
    const i = x.findIndex((c) => c.branch === input.branch && c.sha === input.headSha);
    if (i >= 0) [s, top] = [x.slice(0, i + 1), x[i]];
  }
  if (!top) {
    // Merged again (a Deploy run again after one that kept a branch under an open pull request): not deleted unseen.
    const was = await ctx.store.db.get<StackChange>(
      "SELECT * FROM stack_changes WHERE app_id = ? AND branch = ? AND sha = ? AND state = 'landed'", ctx.appId, input.branch, input.headSha,
    );
    if (!was) return null;
    const pullErrors: PullError[] = [];
    const deleted = ctx.repo.delete_branch && input.deleteBelow ? await dropLanded(ctx, was.stack_id, undefined, pullErrors) : [];
    return { stack: was.stack_name, changes: 0, deleted, ...(pullErrors.length ? { pullErrors } : {}) };
  }
  const n = await ctx.store.landStack(ctx.appId, top.stack_id, top.position, input.mergedSha);
  const pullErrors: PullError[] = [];
  let deleted: string[] = [];
  if (ctx.repo.delete_branch && input.deleteBelow) {
    // This stack's landed branches, the merged one too (also from an earlier run), but not under a pull request still
    // open: merged in one merge, the ones above the bottom can't be marked merged any more.
    deleted = await dropLanded(ctx, top.stack_id, undefined, pullErrors);
    await dropLandedAside(ctx, top.stack_id);
  }
  return { stack: top.stack_name, changes: n, deleted, ...(pullErrors.length ? { pullErrors } : {}) };
}

// ---- pull requests: one per change, each based on the branch of the change below (the bottom one on the default
// branch), so each shows one request's diff; opened on submit (or after each change, with the app's setting on).

export interface PullError { change: string; position: number; error: string }
const why = (e: unknown) => (e instanceof HttpError ? e.message : "GitHub didn't answer as expected");

/** Closes (changes set aside) or reopens (restored) changes' pull requests, best effort: what failed is returned. */
async function setPulls(ctx: Ctx, changes: StackChange[], state: "open" | "closed"): Promise<PullError[]> {
  const errors: PullError[] = [];
  await pool(changes, 4, async (c) => {
    try {
      // Closing: also one opened from its branch before the stack was submitted (recorded, so restore reopens it).
      let n = c.pr_number;
      if (!n && state === "closed") {
        n = (await ctx.provider.findPull(ctx.r, c.branch))?.number ?? null;
        if (n) await ctx.store.setStackChangePull(c.id, n);
      }
      if (!n) return;
      const p = await ctx.provider.getPull(ctx.r, n);
      if (!p.merged && p.state !== state) await ctx.provider.updatePull(ctx.r, n, { state });
    } catch (e) {
      // (An expired GitHub token too: the stack has changed already, so it's said here, not thrown.)
      errors.push({ change: c.id, position: c.position, error: why(e) });
    }
  });
  return errors.sort((x, y) => x.position - y.position);
}

/** Text for a markdown table cell. */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** No one notified: an `@name` in a prompt or title stays text. */
const quiet = (s: string) => s.replace(/@(?=[\w-])/g, "@\u200b");

/** A change's pull request description: its prompt, and the whole stack (newest on top), this change marked. */
export function pullBody(c: StackChange, stack: StackChange[], numbers: Map<string, number>, defaultBranch: string) {
  const prompt = quiet(c.prompt.trim() ? c.prompt.trim().slice(0, 2000).split(/\r?\n/).map((l) => `> ${l}`).join("\n") : `> ${c.title}`);
  const rows = [...stack].reverse().map((x) => {
    const n = numbers.get(x.id);
    return `| ${x.id === c.id ? "→" : ""} | ${x.position} · ${quiet(cell(x.title))} | ${n ? `#${n}` : ""} |`;
  });
  return [
    prompt,
    "",
    `**Stack \`${cell(c.stack_name)}\`**: one pull request per AI builder request in Cresslet, each based on the one below it, so this one shows only its own change.`,
    "",
    "| | Change | Pull request |",
    "| --- | --- | --- |",
    ...rows,
    `| | \`${cell(defaultBranch)}\` | |`,
  ].join("\n");
}

export interface Submitted { change: string; position: number; number?: number; url?: string; created?: boolean; merged?: boolean; error?: string }

/**
 * Submits a stack: a pull request per open change, the bottom one into the default branch, each other one into the
 * branch of the change below. One that exists (recorded, or open from that branch) is found, reopened if closed, and
 * pointed at the right base; the others are opened, as the user. Then every description gets the stack's table. A
 * change GitHub refuses is said, and the others go on.
 */
export function submitStack(ctx: Ctx, stackId: string): Promise<{ pulls: Submitted[] }> {
  return locked(ctx.appId, () => submitNow(ctx, stackId));
}

/** submitStack, for a caller holding the app's lock already. */
async function submitNow(ctx: Ctx, stackId: string): Promise<{ pulls: Submitted[] }> {
  {
    const s = byStack((await ctx.store.openStackChanges(ctx.appId)).filter((c) => c.stack_id === stackId))[0];
    if (!s) throw new HttpError(404, "no such stack open", "not_found");
    const { provider, r } = ctx;
    const out: Submitted[] = [], pulls = new Map<string, Pull>();
    for (const [i, c] of s.entries()) {
      const below = i ? s[i - 1].branch : ctx.repo.default_branch;
      try {
        let p: Pull | null = c.pr_number
          ? await provider.getPull(r, c.pr_number).catch((e) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e)))
          : null;
        // Merged on GitHub already (by hand): nothing more to open for it.
        if (p && p.head === c.branch && p.merged) {
          out.push({ change: c.id, position: c.position, number: p.number, url: p.url, merged: true });
          continue;
        }
        if (p && p.head !== c.branch) p = null;
        p ??= await provider.findPull(r, c.branch);
        let created = false;
        if (p && p.state === "closed") p = await provider.updatePull(r, p.number, { state: "open" });
        // Above one merged by hand, its base is left as it is (landing part of a stack is #122's).
        const belowMerged = i > 0 && out.some((o) => o.change === s[i - 1].id && o.merged);
        if (p && p.base !== below && !belowMerged) p = await provider.updatePull(r, p.number, { base: below });
        if (!p) {
          p = await provider.createPull(r, { head: c.branch, base: below, title: c.title, body: pullBody(c, s, new Map(), ctx.repo.default_branch) });
          created = true;
        }
        if (c.pr_number !== p.number) await ctx.store.setStackChangePull(c.id, p.number);
        pulls.set(c.id, p);
        out.push({ change: c.id, position: c.position, number: p.number, url: p.url, created });
      } catch (e) {
        if (e instanceof HttpError && e.code === "git_reauth_required") throw e;
        out.push({ change: c.id, position: c.position, error: why(e) });
      }
    }
    const numbers = new Map([...pulls].map(([id, p]) => [id, p.number]));
    for (const x of out) if (x.merged && x.number) numbers.set(x.change, x.number);
    await pool(s.filter((c) => pulls.has(c.id)), 4, async (c) => {
      try {
        await provider.updatePull(r, pulls.get(c.id)!.number, { title: c.title, body: pullBody(c, s, numbers, ctx.repo.default_branch) });
      } catch (e) {
        if (e instanceof HttpError && e.code === "git_reauth_required") throw e;
        const x = out.find((o) => o.change === c.id)!;
        x.error = `its description wasn't updated: ${why(e)}`;
      }
    });
    return { pulls: out };
  }
}

/**
 * A branch's pull request, when it's an open change of a stack (Source control's pull request, and a protected
 * default branch's: the stack's, never a second one into the default branch). `open`: submits its stack first.
 */
export async function changePull(ctx: Ctx, branch: string, open: boolean): Promise<{ pull: PullInfo | null; created?: boolean; errors?: Submitted[] } | null> {
  // One read: the change and its state (a go back between two reads can't slip it past).
  const c = await ctx.store.stackChangeByBranch(ctx.appId, branch);
  if (!c) return null;
  if (c.state === "set_aside") {
    if (open) throw setAside(c);
    return { pull: null };
  }
  if (open) {
    const sub = (await submitStack(ctx, c.stack_id)).pulls;
    const x = sub.find((p) => p.change === c.id);
    if (!x?.number) throw new HttpError(422, x?.error ?? "GitHub wouldn't open its pull request", "pull_invalid");
    // Every problem along the chain (this one's description too) is said with it.
    const errors = sub.filter((p) => p.error);
    return { pull: await ctx.provider.pullStatus(ctx.r, x.number), created: !!x.created, ...(errors.length ? { errors } : {}) };
  }
  if (!c.pr_number) return { pull: null };
  // Closed unmerged (or gone) on GitHub: none, so Source control offers to open it again. Merged: shown.
  const p = await ctx.provider.getPull(ctx.r, c.pr_number).catch((e) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e)));
  return { pull: p && (p.state === "open" || p.merged) ? await ctx.provider.pullStatus(ctx.r, c.pr_number) : null };
}

/** The review and checks of a stack's pull requests, by change id. */
export async function stackPulls(ctx: Ctx, stackId: string): Promise<Record<string, PullInfo>> {
  const s = (await ctx.store.openStackChanges(ctx.appId)).filter((c) => c.stack_id === stackId && c.pr_number);
  const info = await pool(s, 4, (c) => ctx.provider.pullStatus(ctx.r, c.pr_number!).catch(() => null));
  return Object.fromEntries(s.flatMap((c, i) => (info[i] ? [[c.id, info[i]!]] : [])));
}

// ---- branches changed outside the studio, and changes set aside

/**
 * Deletes changes' branches (set aside ones), each only while it still points at its change (or is gone already):
 * those are `dropped`. One pushed to since is kept, and said.
 */
async function dropBranches(ctx: Ctx, changes: StackChange[], then?: (dropped: string[]) => Promise<void>): Promise<{ dropped: string[]; kept: PullError[] }> {
  const dropped: string[] = [], kept: PullError[] = [];
  await pool(changes, 4, async (c) => {
    try {
      const head = await ctx.provider.branchHead(ctx.r, c.branch);
      if (head && head !== c.sha) {
        kept.push({ change: c.id, position: c.position, error: `${c.branch} was pushed to on GitHub since: delete it there` });
        return;
      }
      // GitHub refusing (a 422: a rule, say) comes back as false: only one gone counts.
      if (head && !await ctx.provider.deleteBranch(ctx.r, c.branch) && await ctx.provider.branchHead(ctx.r, c.branch)) {
        kept.push({ change: c.id, position: c.position, error: `GitHub didn't delete ${c.branch}` });
        return;
      }
      dropped.push(c.id);
    } catch (e) {
      kept.push({ change: c.id, position: c.position, error: why(e) });
    }
  });
  // Out of their stack (their positions free for new changes), one new id per stack they were in; with `then`, in one
  // transaction.
  const byId = new Map(changes.map((c) => [c.id, c]));
  await ctx.store.db.tx(async () => {
    for (const stack of new Set(dropped.map((x) => byId.get(x)!.stack_id))) {
      await ctx.store.moveStackChanges(ctx.appId, dropped.filter((x) => byId.get(x)!.stack_id === stack), id("stk"), "dropped");
    }
    await then?.(dropped);
  });
  return { dropped, kept };
}

/** Every change set aside (restorable or not), newest first, checked against GitHub: Source control lists them. */
export async function setAsideBranches(ctx: Ctx): Promise<(ChangeView & { stackName: string; restorable: boolean })[]> {
  const open = new Set((await ctx.store.openStackChanges(ctx.appId)).map((c) => c.stack_id));
  const aside = (await ctx.store.setAsideStackChanges(ctx.appId)).sort((x, y) => y.created_at - x.created_at);
  const heads = await pool(aside, 8, (c) => ctx.provider.branchHead(ctx.r, c.branch).catch(() => null));
  return aside.map((c, i) => ({
    ...view(c), stackName: c.stack_name, restorable: open.has(c.stack_id),
    ...(heads[i] === c.sha ? { github: "ok" as const } : heads[i] ? { github: "moved" as const, headSha: heads[i]! } : { github: "gone" as const }),
  }));
}

/**
 * Deletes a change set aside: its branch, and those of the ones set aside above it in its stack (cut from it). The
 * ones below stay restorable.
 */
export function deleteSetAside(ctx: Ctx, changeId: string): Promise<{ dropped: string[]; kept: PullError[] }> {
  return locked(ctx.appId, async () => {
    const aside = await ctx.store.setAsideStackChanges(ctx.appId);
    const c = aside.find((x) => x.id === changeId);
    if (!c) throw new HttpError(404, "no such change set aside", "not_found");
    // One kept above one deleted (pushed to since) can't come back over the gap: out of the stack, still listed.
    return dropBranches(ctx, aside.filter((x) => x.stack_id === c.stack_id && x.position >= c.position), async (dropped) => {
      if (dropped.length) await ctx.store.detachSetAside(ctx.appId, c.stack_id, id("stk"), Math.min(...dropped.map((x) => aside.find((y) => y.id === x)!.position)));
    });
  });
}

/** An open change whose branch is at `sha` on GitHub, another commit than its own (pushed to from outside). */
async function movedChange(ctx: Ctx, changeId: string, sha: string) {
  const open = await ctx.store.openStackChanges(ctx.appId);
  const c = open.find((x) => x.id === changeId);
  if (!c) throw new HttpError(404, "no such change open on a stack", "not_found");
  const head = await ctx.provider.branchHead(ctx.r, c.branch);
  if (!head) throw new HttpError(404, `${c.branch} is gone on GitHub`, "branch_not_found");
  if (head !== sha) throw new HttpError(409, `${c.branch} moved on GitHub again: look at the stack again`, "conflict");
  // Taken in already (another tab, say): nothing to do, and nothing above it is touched.
  if (head === c.sha) throw new HttpError(409, `${c.branch} isn't changed on GitHub any more: look at the stack again`, "conflict");
  return { c, open, head };
}

/**
 * A change's branch was pushed to on GitHub: pull that in as the top of the stack. The change takes the branch's
 * commit; the changes above it are set aside for good (they don't hold that commit; their branches kept, their pull
 * requests closed). The next change goes on it.
 */
export function pullIn(ctx: Ctx, changeId: string, sha: string): Promise<{ change: ChangeView; dropped: number; pullErrors?: PullError[] }> {
  return locked(ctx.appId, async () => {
    const { c, open, head } = await movedChange(ctx, changeId, sha);
    const above = open.filter((x) => x.stack_id === c.stack_id && x.position > c.position);
    await ctx.store.db.tx(async () => {
      await ctx.store.setAsideAbove(ctx.appId, c.stack_id, c.position);
      await ctx.store.detachSetAside(ctx.appId, c.stack_id, id("stk"));
      await ctx.store.setStackChangeSha(c.id, head);
    });
    const pullErrors = await setPulls(ctx, above, "closed");
    return { change: { ...view({ ...c, sha: head }), github: "ok" }, dropped: above.length, ...(pullErrors.length ? { pullErrors } : {}) };
  });
}

/**
 * A change's branch was pushed to on GitHub: carry on from it as a branch of its own. The stack ends: all its changes
 * leave it (their branches kept; the ones below are in that branch anyway), and those set aside can't come back. The
 * workspace then commits to that branch as before stacks.
 */
export function carryOn(ctx: Ctx, changeId: string, sha: string): Promise<{ change: ChangeView; left: number }> {
  return locked(ctx.appId, async () => {
    const { c, open, head } = await movedChange(ctx, changeId, sha);
    const leaving = open.filter((x) => x.stack_id === c.stack_id);
    await ctx.store.db.tx(async () => {
      await ctx.store.detachSetAside(ctx.appId, c.stack_id, id("stk"));
      await ctx.store.moveStackChanges(ctx.appId, leaving.map((x) => x.id), id("stk"), "outside");
    });
    return { change: { ...view({ ...c, sha: head }), github: "ok" }, left: leaving.length };
  });
}

/** A stack's changes set aside (also ones moved out of it for good) go once nothing of it is open any more. */
async function dropLandedAside(ctx: Ctx, stackId: string) {
  if ((await ctx.store.openStackChanges(ctx.appId)).some((c) => c.stack_id === stackId)) return;
  await dropBranches(ctx, (await ctx.store.setAsideStackChanges(ctx.appId)).filter((c) => c.stack_id === stackId || c.origin_stack_id === stackId));
}

// ---- landing: the default branch moved forward to a change, one change at a time

/** A change's open pull request (recorded, or open from its branch), pointed at `base` if it isn't. */
async function retarget(ctx: Ctx, c: StackChange, base: string) {
  let p = c.pr_number ? await ctx.provider.getPull(ctx.r, c.pr_number).catch((e) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e))) : null;
  if (!p || p.head !== c.branch || p.state !== "open") p = await ctx.provider.findPull(ctx.r, c.branch);
  if (p && p.state === "open" && p.base !== base) await ctx.provider.updatePull(ctx.r, p.number, { base });
}

/**
 * Lands a change and the ones below it (when the default branch takes direct moves): one at a time, each change's
 * pull request is pointed at the default branch and the default branch moved (fast-forward, never forced) to its
 * commit, so GitHub marks each merged with only its own turn (checked against GitHub, #117/#122). Each step is
 * recorded as it's done, so a landing that stops half way carries on from there. Then the change above becomes the
 * bottom (its pull request on the default branch), and the landed branches go (the app's delete-branch setting, only
 * while at their change). Refused, before anything moves: a protected default branch (`branch_protected`), one that
 * moved since the stack was cut (`default_moved`), a change pushed to on GitHub (`moved`).
 */
export function landUpTo(ctx: Ctx, changeId: string, expect?: string): Promise<{ landed: ChangeView[]; sha: string; stack: string; deleted: string[]; pullErrors?: PullError[] }> {
  return locked(ctx.appId, async () => {
    const { provider, store, r, repo, appId } = ctx;
    const open = await store.openStackChanges(appId);
    const c = open.find((x) => x.id === changeId);
    if (!c) throw new HttpError(404, "no such change open on a stack", "not_found");
    const def = repo.default_branch;
    // Protection first: no refusal below may let a caller fall back to a move past it.
    const guarded = await provider.branchProtection(r, def);
    if (guarded) throw new HttpError(422, `${guarded}: land the stack through its pull requests on GitHub`, "branch_protected");
    // The commit the caller synced and will build (Deploy): the change must still be at it, checked under the lock.
    if (expect && c.sha !== expect) throw new HttpError(409, `${c.branch} isn't at the commit that was synced`, "not_synced");
    const s = byStack(open.filter((x) => x.stack_id === c.stack_id))[0];
    let k = s.findIndex((x) => x.id === c.id);
    let at = await provider.branchHead(r, def);
    if (!at) throw new HttpError(404, `no branch ${def} on GitHub`, "branch_not_found");
    // Where the default branch is: where the stack was cut, or at one of its changes (a landing that stopped half way,
    // or went further: what's landed is all of it).
    let from = 0;
    if (at !== s[0].base_sha) {
      const j = s.findIndex((x) => x.sha === at);
      if (j < 0) {
        throw new HttpError(409, `${def} has commits the stack doesn't (it moved on GitHub, or the stack wasn't cut from it): nothing was landed. Deploy merges it in (resolving any conflicts there)`, "default_moved");
      }
      from = j + 1;
      k = Math.max(k, j);
    }
    // Each change still to move: on GitHub at its commit (pushed to: pull it in first; deleted: not landed unseen).
    const heads = await pool(s.slice(from, k + 1), 8, (x) => provider.branchHead(r, x.branch));
    const off = s.slice(from, k + 1).find((x, i) => heads[i] !== x.sha);
    if (off) {
      throw heads[s.indexOf(off) - from]
        ? new HttpError(409, `${off.branch} was pushed to on GitHub: pull it in, or carry on from it, first`, "moved")
        : new HttpError(404, `${off.branch} is gone on GitHub: nothing was landed`, "branch_not_found");
    }
    if (from) await store.landStack(appId, c.stack_id, s[from - 1].position, s[from - 1].sha);
    for (let i = from; i <= k; i++) {
      const x = s[i];
      // Its pull request on the default branch first (the bottom's too: a landing that stopped half way may have left
      // it on the branch below): one whose base moves past it without it can't be marked merged.
      await retarget(ctx, x, def);
      await provider.moveBranch(r, def, at, x.sha);
      at = x.sha;
      await store.landStack(appId, c.stack_id, x.position, x.sha);
    }
    // The change above is the bottom now: its pull request on the default branch, before any branch below goes (an
    // API delete of a base branch closes the pull requests on it for good). If that fails, its base branch stays.
    const pullErrors: PullError[] = [], deleted: string[] = [];
    let keep: string | undefined;
    if (s[k + 1]) {
      await retarget(ctx, s[k + 1], def).catch((e) => {
        keep = s[k].branch;
        pullErrors.push({ change: s[k + 1].id, position: s[k + 1].position, error: `${why(e)} (${keep} is kept until it's on ${def}: land again)` });
      });
    }
    if (repo.delete_branch) {
      // This stack's landed branches (also ones landed by an earlier run), while at their change; GitHub's own "delete
      // branch on merge" may have done it: gone is fine.
      deleted.push(...await dropLanded(ctx, c.stack_id, keep, pullErrors, new Set(s.slice(from, k + 1).map((x) => x.id))));
      await dropLandedAside(ctx, c.stack_id);
    }
    return {
      landed: s.slice(0, k + 1).map((x) => ({ ...view(x), github: "ok" as const })), sha: at, stack: c.stack_name, deleted,
      ...(pullErrors.length ? { pullErrors } : {}),
    };
  });
}

/**
 * Deletes a stack's landed branches (also ones landed by an earlier run) while at their change, but `keep`, and any
 * that's the head or base of a pull request still open (the default branch moved past it outside Cresslet: deleting
 * it would close that pull request unmerged), said in `errors`. Gone already (GitHub's "delete branch on merge") is fine.
 */
async function dropLanded(ctx: Ctx, stackId: string, keep: string | undefined, errors: PullError[], moved: Set<string> = new Set()): Promise<string[]> {
  const rows = await ctx.store.db.all<StackChange>("SELECT * FROM stack_changes WHERE app_id = ? AND stack_id = ? AND state = 'landed'", ctx.appId, stackId);
  const held = new Set<string>(keep ? [keep] : []);
  let unknown = false;
  // (Not the ones this run moved: their pull requests were on the default branch as it reached them, so merged.)
  await pool(rows.filter((x) => !moved.has(x.id)), 4, async (x) => {
    try {
      let p = x.pr_number ? await ctx.provider.getPull(ctx.r, x.pr_number).catch((e) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e))) : null;
      // (A recorded one closed: maybe another was opened from it since.)
      if (!p || p.head !== x.branch || p.state !== "open") p = await ctx.provider.findPull(ctx.r, x.branch) ?? p;
      if (p?.state === "open") {
        held.add(p.head).add(p.base);
        errors.push({ change: x.id, position: x.position, error: `pull request #${p.number} is still open (its change is in ${ctx.repo.default_branch} already): its branches are kept, close it on GitHub` });
      }
    } catch (e) {
      // Not known whether a pull request is on it, nor what its base is: none of the stack's branches go this time.
      unknown = true;
      errors.push({ change: x.id, position: x.position, error: `${x.branch}'s pull request couldn't be read (${why(e)}): the stack's branches are kept for now` });
    }
  });
  // The stack's next change (still open): its pull request may be on a landed branch (its move onto the default branch
  // failed): that base stays.
  const next = byStack((await ctx.store.openStackChanges(ctx.appId)).filter((x) => x.stack_id === stackId))[0]?.[0];
  if (next) {
    try {
      let p = next.pr_number ? await ctx.provider.getPull(ctx.r, next.pr_number).catch((e) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e))) : null;
      if (!p || p.head !== next.branch || p.state !== "open") p = await ctx.provider.findPull(ctx.r, next.branch) ?? p;
      if (p?.state === "open") {
        held.add(p.base);
        if (p.base !== ctx.repo.default_branch && p.base !== keep) errors.push({ change: next.id, position: next.position, error: `pull request #${p.number} is still on ${p.base}, which is kept until it's on ${ctx.repo.default_branch} (land again, or submit the stack)` });
      }
    } catch (e) {
      unknown = true;
      errors.push({ change: next.id, position: next.position, error: `${next.branch}'s pull request couldn't be read (${why(e)}): the stack's branches are kept for now` });
    }
  }
  const deleted: string[] = [];
  if (unknown) return deleted;
  await pool(rows.filter((x) => !held.has(x.branch)), 4, async (x) => {
    if (await ctx.provider.branchHead(ctx.r, x.branch).catch(() => null) === x.sha && await ctx.provider.deleteBranch(ctx.r, x.branch).catch(() => false)) deleted.push(x.branch);
  });
  return deleted;
}

// ---- folding a change into the one below

/**
 * Folds a change into the one below it, for a small follow-up that doesn't deserve a pull request of its own. The
 * chain is straight, so no commit changes: the lower change's branch and pull request go, the upper one takes its
 * place (its base, its position, the lower one's title, both prompts). Its pull request is pointed at the lower one's
 * base first, so no pull request is closed by a base branch being deleted; the lower one's is closed with a note
 * pointing at it. The stack's pull request tables are refreshed. Not the bottom change (nothing below it), nor one set
 * aside or landed.
 */
export function fold(ctx: Ctx, changeId: string): Promise<{ change: ChangeView; dropped: string; pullErrors?: PullError[] }> {
  return locked(ctx.appId, async () => {
    const { provider, store, r, repo, appId } = ctx;
    const open = await store.openStackChanges(appId);
    const upper = open.find((x) => x.id === changeId);
    if (!upper) throw new HttpError(404, "no such change open on a stack (one set aside or landed can't be folded)", "not_found");
    const s = byStack(open.filter((x) => x.stack_id === upper.stack_id))[0];
    const i = s.indexOf(upper);
    if (i === 0) throw new HttpError(409, `${upper.branch} is the stack's bottom change: there's nothing below it to fold it into`, "bottom");
    const lower = s[i - 1];
    const heads = await Promise.all([lower, upper].map((x) => provider.branchHead(r, x.branch)));
    const off = [lower, upper].find((x, j) => heads[j] !== x.sha);
    if (off) throw new HttpError(409, `${off.branch} ${heads[[lower, upper].indexOf(off)] ? "was pushed to" : "is gone"} on GitHub: nothing was folded`, "moved");
    const base = i > 1 ? s[i - 2].branch : repo.default_branch;
    // Its pull request onto the lower one's base first (before that branch goes). Refused: nothing changes.
    await retarget(ctx, upper, base);
    const prompt = [lower.prompt || lower.title, upper.prompt || upper.title].join("\n\n");
    await store.foldStackChange(lower, upper, id("stk"), prompt);
    const pullErrors: PullError[] = [];
    let hadPull = false;
    // The lower one's pull request: closed, with a note pointing at the one it's in now (opened by the refresh below
    // if it had none).
    try {
      let lp = lower.pr_number ? await provider.getPull(r, lower.pr_number).catch((e) => (e instanceof HttpError && e.status === 404 ? null : Promise.reject(e))) : null;
      if (!lp || lp.head !== lower.branch || lp.state !== "open") lp = await provider.findPull(r, lower.branch) ?? lp;
      if (lp?.state === "open") {
        hadPull = true;
        if (!upper.pr_number && !await provider.findPull(r, upper.branch)) await submitNow(ctx, upper.stack_id);
        const up = (await store.openStackChanges(appId)).find((x) => x.id === upper.id)?.pr_number ?? (await provider.findPull(r, upper.branch))?.number ?? null;
        await provider.commentPull(r, lp.number, `Folded into ${up ? `#${up}` : upper.branch} (Cresslet): ${upper.branch} now holds this change and the one that was above it.`);
        await provider.updatePull(r, lp.number, { state: "closed" });
      }
    } catch (e) {
      pullErrors.push({ change: lower.id, position: lower.position, error: `its pull request wasn't closed: ${why(e)}` });
    }
    // Its branch goes (only while at its change). A pull request still open on it is kept from closing: not deleted.
    if (!pullErrors.length && await provider.branchHead(r, lower.branch).catch(() => null) === lower.sha) await provider.deleteBranch(r, lower.branch).catch(() => false);
    // Tables: the stack's pull requests say what it is now.
    const after = (await store.openStackChanges(appId)).filter((x) => x.stack_id === upper.stack_id);
    if (hadPull || after.some((x) => x.pr_number)) {
      const sub = await submitNow(ctx, upper.stack_id).catch((e) => ({ pulls: [{ change: upper.id, position: lower.position, error: why(e) }] as Submitted[] }));
      for (const x of sub.pulls) if (x.error) pullErrors.push({ change: x.change, position: x.position, error: x.error });
    }
    const now = after.find((x) => x.id === upper.id)!;
    return { change: { ...view(now), github: "ok" }, dropped: lower.id, ...(pullErrors.length ? { pullErrors } : {}) };
  });
}
