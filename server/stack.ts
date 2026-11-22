// Stacked changes (docs/architecture.md#stacked-changes): on a linked app, each AI builder turn that changes files is
// a change: a branch of its own, cut from the commit the workspace was on, holding that turn's commit. The changes
// since the default branch, in order, are a stack. The server records them (store.stack_changes) so every browser
// and collaborator sees the same stack; GitHub stays the authority for where the branches point (readStacks says
// when one moved or is gone). Routes are with the other git routes (server/git.ts); this takes the provider and the
// store, so it's tested without a network (tests/stack_test.ts).
import { HttpError } from "./deploys.ts";
import { type Author, pool, type Repo, type SourceControlProvider } from "./git.ts";
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
  author: c.author, createdAt: new Date(c.created_at).toISOString(),
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
}): Promise<{ changed: false; sha: string } | { changed: true; sha: string; branch: string; change: ChangeView; stack: { id: string; name: string } }> {
  const { provider, store, appId, repo, r } = ctx;
  return locked(appId, async () => {
    const stacks = byStack(await store.openStackChanges(appId));
    let below: StackChange | undefined;
    const aside = input.from === repo.default_branch ? undefined : (await store.setAsideStackChanges(appId)).find((c) => c.branch === input.from);
    if (aside) throw setAside(aside);
    const on = input.from === repo.default_branch ? undefined : stacks.find((s) => s.some((c) => c.branch === input.from));
    if (on) {
      const top = on.at(-1)!; // a stack listed has a change
      if (top.branch !== input.from) throw notOnTop(on.find((c) => c.branch === input.from)!, top);
      if (top.sha !== input.baseSha) throw notOnStack(`${input.from} is recorded at another commit than the workspace's`);
      below = top;
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
export function goBack(ctx: Ctx, changeId: string, sha?: string, top?: { id: string; sha: string }): Promise<{ change: ChangeView; stack: { id: string; name: string }; now: string[]; setAside: ChangeView[] }> {
  return locked(ctx.appId, async () => {
    const open = await ctx.store.openStackChanges(ctx.appId);
    const c = open.find((x) => x.id === changeId);
    if (!c) throw new HttpError(404, "no such change open on a stack", "not_found");
    if (sha && c.sha !== sha) throw stackChanged();
    // `top`: the stack's top the caller expects (undoing a restore: nothing added on it since).
    const was = byStack(open.filter((x) => x.stack_id === c.stack_id))[0]!.at(-1)!;
    if (top && (was.id !== top.id || was.sha !== top.sha)) throw stackChanged();
    const now = open.filter((x) => x.stack_id === c.stack_id && x.position > c.position).map((x) => x.id);
    await ctx.store.setAsideAbove(ctx.appId, c.stack_id, c.position);
    const aside = (await ctx.store.setAsideStackChanges(ctx.appId)).filter((x) => x.stack_id === c.stack_id);
    return { change: { ...view(c), github: "ok" }, stack: { id: c.stack_id, name: c.stack_name }, now, setAside: aside.map((x) => ({ ...view(x), github: "ok" as const })) };
  });
}

/**
 * Puts a stack's changes set aside back on it (while nothing was built where they were): all of them, or only `only`
 * (the ones a go back set aside, to undo it). `top`: the change the caller will load, which must be the new top.
 * Resolves to it, and `below`: the top before (to go back to, to undo this).
 */
export function restore(ctx: Ctx, stackId: string, opts: { only?: string[]; top?: { id: string; sha: string } } = {}): Promise<{ change: ChangeView; below: ChangeView; stack: { id: string; name: string }; restored: number }> {
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
    return { change: { ...view(top), github: "ok" }, below: { ...view(before.at(-1)!), github: "ok" }, stack: { id: top.stack_id, name: top.stack_name }, restored: n };
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
 * landed, and with `deleteBelow` the branches below it go (the merge route deletes its own) when the app's
 * delete-branch setting is on and they still point at their change. A change added on top stays open.
 */
export async function landed(ctx: Ctx, input: { branch: string; headSha: string; mergedSha: string; deleteBelow: boolean }): Promise<{ stack: string; changes: number } | null> {
  let s: StackChange[] = [], top: StackChange | undefined;
  for (const x of byStack(await ctx.store.openStackChanges(ctx.appId))) {
    const i = x.findIndex((c) => c.branch === input.branch && c.sha === input.headSha);
    if (i >= 0) [s, top] = [x.slice(0, i + 1), x[i]];
  }
  if (!top) return null;
  const n = await ctx.store.landStack(ctx.appId, top.stack_id, top.position, input.mergedSha);
  if (ctx.repo.delete_branch && input.deleteBelow) {
    await pool(s.slice(0, -1), 4, async (c) => {
      if (await ctx.provider.branchHead(ctx.r, c.branch).catch(() => null) === c.sha) await ctx.provider.deleteBranch(ctx.r, c.branch).catch(() => false);
    });
  }
  return { stack: top.stack_name, changes: n };
}
