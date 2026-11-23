// Stacked changes (server/stack.ts) over a fake source control provider: no network, no GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../server/deploys.ts";
import type { CommitInput, Pull, PullInfo, Repo, SourceControlProvider } from "../server/git.ts";
import {
  assertNotBelowTop, carryOn, changePull, commitChange, type Ctx, deleteSetAside, fold, followed, pullBody, undoPlan, goBack, landed, landNext, landUpTo, MAX_STACK, assertLinked, assertSyncable, restack, pullIn, readStacks, restore,
  setAsideBranches, slug, stackPulls, submitStack, updateBottom,
} from "../server/stack.ts";
import { type AppRepo, Store } from "../server/store.ts";

/** Branches and commits in memory: a commit is its files and its parent (a merge: and a second one). */
function fakeProvider() {
  const commits = new Map<string, { files: Map<string, string>; parent: string | null; parent2?: string }>();
  const refs = new Map<string, string>();
  let n = 0;
  const make = (files: Map<string, string>, parent: string | null) => {
    const sha = String(++n).padStart(40, "0");
    commits.set(sha, { files, parent });
    return sha;
  };
  refs.set("main", make(new Map([["index.html", "<h1>hi</h1>"]]), null));
  const no = () => { throw new Error("not used here"); };
  // A name in the way: an existing branch, or one that's a folder of it (or the other way), as git refuses.
  const taken = (b: string) => [...refs.keys()].some((x) => x === b || b.startsWith(x + "/") || x.startsWith(b + "/"));
  const pulls: (Pull & { title: string; body: string; mergedHead?: string })[] = [];
  const refuse = new Set<string>(); // branches GitHub won't open a pull request from
  const keep = new Set<string>(); // branches GitHub won't delete (a rule)
  const guarded = new Set<string>(); // protected branches
  const failUpdate = new Set<number>(); // pull requests GitHub won't change (once)
  const comments: { n: number; body: string }[] = [];
  // Landing through pull requests: the methods allowed, why GitHub won't merge one, what it says about one, and
  // GitHub's own "delete branch on merge" (it deletes the head and moves the pull requests on it to the base).
  const methods = { merge: true, squash: true, rebase: true };
  const unmergeable = new Map<number, string>();
  const status = new Map<number, Partial<PullInfo>>();
  const gh = { deleteOnMerge: false };
  const contains = (sha: string, of: string) => { // `of` is `sha` or one of its ancestors
    const todo = [sha], seen = new Set<string>();
    while (todo.length) {
      const x = todo.pop()!;
      if (x === of) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      const c = commits.get(x);
      if (c?.parent) todo.push(c.parent);
      if (c?.parent2) todo.push(c.parent2);
    }
    return false;
  };
  const pullOf = (n: number) => {
    const x = pulls[n - 1];
    if (!x) throw new HttpError(404, "not found on GitHub", "git_not_found");
    return x;
  };
  const p: SourceControlProvider & {
    refs: Map<string, string>; commits: typeof commits; pulls: typeof pulls; refuse: Set<string>; keep: Set<string>; guarded: Set<string>; failUpdate: Set<number>; comments: { n: number; body: string }[];
    methods: typeof methods; unmergeable: typeof unmergeable; status: typeof status; gh: typeof gh;
    push(branch: string, files: Record<string, string>): string;
  } = {
    refs, commits, pulls, refuse, keep, guarded, failUpdate, comments, methods, unmergeable, status, gh,
    async contains(_r: Repo, sha: string, of: string) {
      return contains(sha, of);
    },
    async mergeMethods() {
      return { ...methods };
    },
    async commitParents(_r: Repo, sha: string) {
      const c = commits.get(sha)!;
      return [c.parent, c.parent2].filter((x): x is string => !!x);
    },
    async syncCommit(_r: Repo, input: { branch: string; from: string; with: string; message: string }) {
      if (refs.get(input.branch) !== input.from) throw new HttpError(409, `${input.branch} moved on GitHub meanwhile: try again`, "conflict");
      const sha = make(new Map(commits.get(input.from)!.files), input.from);
      commits.get(sha)!.parent2 = input.with;
      refs.set(input.branch, sha);
      return sha;
    },
    async mergePull(_r: Repo, n: number, input: { sha: string; title: string; method?: "merge" | "squash" }) {
      const x = pullOf(n);
      if (x.state !== "open") throw new HttpError(409, `GitHub didn't merge pull request #${n}: Pull Request is not mergeable`, "merge_refused");
      if (unmergeable.has(n)) throw new HttpError(409, `GitHub didn't merge pull request #${n}: ${unmergeable.get(n)}`, "merge_refused");
      if (refs.get(x.head) !== input.sha) throw new HttpError(409, `GitHub didn't merge pull request #${n}: Head branch was modified. Review and try the merge again.`, "merge_refused");
      // A merge commit: the head's files, on the base and the head. Squashed: the head's files, on the base only.
      const sha = make(new Map(commits.get(input.sha)!.files), refs.get(x.base) ?? null);
      if (input.method !== "squash") commits.get(sha)!.parent2 = input.sha;
      refs.set(x.base, sha);
      Object.assign(x, { state: "closed", merged: true, mergeSha: sha, mergedHead: input.sha });
      if (gh.deleteOnMerge) {
        refs.delete(x.head);
        for (const y of pulls) if (y.state === "open" && y.base === x.head) y.base = x.base;
      }
      return { sha };
    },
    async merge(_r: Repo, input: { into: string; head: string; message: string; expect?: string }) {
      // `head` merged into `into` (a merge commit): file by file against their nearest common commit; both changed one: 409.
      const [into, head] = [refs.get(input.into)!, refs.get(input.head)!];
      if (input.expect && head !== input.expect) throw new HttpError(409, `${input.head} moved on GitHub since it was synced: pull it first`, "conflict");
      if (contains(into, head)) return { mergedSha: into, headSha: head, fastForward: false, treeChanged: false };
      const order: string[] = [];
      for (const todo = [into], seen = new Set<string>(); todo.length;) {
        const x = todo.shift()!;
        if (seen.has(x)) continue;
        seen.add(x);
        order.push(x);
        const c = commits.get(x)!;
        if (c.parent) todo.push(c.parent);
        if (c.parent2) todo.push(c.parent2);
      }
      const base = order.find((x) => contains(head, x))!;
      const [b, o, t] = [base, into, head].map((x) => commits.get(x)!.files);
      const files = new Map<string, string>(), paths: string[] = [];
      for (const path of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
        const [x, y, z] = [b.get(path), o.get(path), t.get(path)];
        const pick = y === z || z === x ? y : y === x ? z : undefined;
        if (!(y === z || z === x || y === x)) paths.push(path);
        else if (pick !== undefined) files.set(path, pick);
      }
      if (paths.length) throw Object.assign(new HttpError(409, `${input.head} doesn't merge cleanly into ${input.into}`, "merge_conflict"), { extra: { paths: paths.sort() } });
      const sha = make(files, into);
      commits.get(sha)!.parent2 = head;
      refs.set(input.into, sha);
      return { mergedSha: sha, headSha: head, fastForward: false, treeChanged: true };
    },
    async branchProtection(_r: Repo, branch: string) {
      return guarded.has(branch) ? `${branch} is protected on GitHub` : null;
    },
    async moveBranch(_r: Repo, branch: string, from: string, to: string) {
      if (refs.get(branch) !== from || !contains(to, from)) throw new HttpError(409, `${branch} moved on GitHub meanwhile: try again`, "conflict");
      refs.set(branch, to);
      // GitHub marks a pull request merged when its base moves to hold its head.
      for (const x of pulls) if (x.state === "open" && x.base === branch && contains(to, refs.get(x.head) ?? "")) Object.assign(x, { state: "closed", merged: true });
    },
    async getPull(_r: Repo, n: number) {
      const x = pullOf(n);
      return { ...x, headSha: x.mergedHead ?? refs.get(x.head) };
    },
    async findPull(_r: Repo, head: string) {
      const x = pulls.find((y) => y.head === head && y.state === "open");
      return x ? { ...x } : null;
    },
    async createPull(_r: Repo, input: { head: string; base: string; title: string; body: string }) {
      if (refuse.has(input.head)) throw new HttpError(422, "Validation Failed", "pull_invalid");
      const x = { number: pulls.length + 1, url: `https://github.example/octo/shop/pull/${pulls.length + 1}`, state: "open" as const, merged: false, ...input };
      pulls.push(x);
      return { ...x };
    },
    async updatePull(_r: Repo, n: number, input: { base?: string; title?: string; body?: string; state?: "open" | "closed" }) {
      if (failUpdate.delete(n)) throw new HttpError(502, "GitHub: Server Error", "github_error");
      Object.assign(pullOf(n), Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)));
      return { ...pullOf(n) };
    },
    async revert(_r: Repo, input: { change: string; parent: string; top: string; label: string }) {
      const [b, o, t] = [input.change, input.top, input.parent].map((x) => commits.get(x)!.files);
      const files: { path: string; data: string; encoding: "utf8" }[] = [], conflicts: string[] = [];
      for (const path of [...new Set([...b.keys(), ...o.keys(), ...t.keys()])].sort()) {
        const [x, y, z] = [b.get(path), o.get(path), t.get(path)];
        const pick = y === z || z === x ? y : y === x ? z : undefined;
        if (y === z || z === x || y === x) {
          if (pick !== undefined) files.push({ path, data: pick, encoding: "utf8" });
          continue;
        }
        conflicts.push(path);
        files.push({ path, data: `<<<<<<< now\n${y ?? ""}\n=======\n${z ?? ""}\n>>>>>>> undo ${input.label}\n`, encoding: "utf8" });
      }
      return { files, conflicts };
    },
    async commentPull(_r: Repo, n: number, body: string) {
      comments.push({ n, body });
    },
    async pullStatus(_r: Repo, n: number) {
      const x = pullOf(n);
      return { number: n, url: x.url, title: x.title, draft: false, headSha: refs.get(x.head) ?? "", review: "approved" as const, checks: "success" as const, base: x.base, mergeable: "clean" as const, ...status.get(n) };
    },
    push(branch, files) {
      const head = refs.get(branch)!;
      const sha = make(new Map([...commits.get(head)!.files, ...Object.entries(files)]), head);
      refs.set(branch, sha);
      return sha;
    },
    listRepos: no, createRepo: no, repo: no, listBranches: no, readTree: no,
    async branchHead(_r: Repo, branch: string) {
      return refs.get(branch) ?? null;
    },
    async createBranch(_r: Repo, branch: string, sha: string) {
      if (taken(branch)) throw new HttpError(409, `branch ${branch} already exists`, "branch_exists");
      refs.set(branch, sha);
    },
    async deleteBranch(_r: Repo, branch: string) {
      return !keep.has(branch) && refs.delete(branch);
    },
    async commitTree(_r: Repo, input: CommitInput) {
      const base = commits.get(input.baseSha)!;
      const files = new Map(input.files.map(([path, d]) => [path, new TextDecoder().decode(d)]));
      const same = files.size === base.files.size && [...files].every(([k, v]) => base.files.get(k) === v);
      if (same) return { sha: input.baseSha, changed: false };
      const sha = make(files, input.baseSha);
      if (input.mergeParent) commits.get(sha)!.parent2 = input.mergeParent;
      if (input.create) {
        if (taken(input.branch)) throw Object.assign(new HttpError(409, "taken", "branch_exists"), { extra: { sha } });
        refs.set(input.branch, sha);
      } else {
        if (refs.get(input.branch) !== input.baseSha) throw new HttpError(409, "moved", "conflict");
        refs.set(input.branch, sha);
      }
      return { sha, changed: true };
    },
  };
  return p;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cresslet-stack-test-"));
  const store = await Store.open(dir);
  const acct = await store.createAccount("octo@b.co");
  const { app } = await store.createApp("shop", acct.id);
  await store.setAppRepo({
    app_id: app.id, provider: "github", repo_id: "1", owner: "octo", name: "shop", default_branch: "main", subdir: "",
    delete_branch: 1, connected_by: acct.id, last_synced_sha: null,
  });
  const provider = fakeProvider();
  const repo = (await store.getAppRepo(app.id))!;
  const ctx: Ctx = { provider, store, appId: app.id, repo, r: { owner: "octo", name: "shop" } };
  const file = (data: string): [string, Uint8Array][] => [["index.html", new TextEncoder().encode(data)]];
  const author = { name: "octo", email: "octo@users.example" };
  const change = (from: string, baseSha: string, title: string, data: string) =>
    commitChange(ctx, { from, baseSha, files: file(data), title, prompt: `${title}, please`, author, by: acct.id });
  return {
    store, provider, ctx, change, acct, app, repo: repo as AppRepo,
    async [Symbol.asyncDispose]() {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const ok = <T extends { changed: boolean }>(x: T) => {
  assert.equal(x.changed, true);
  return x as Extract<T, { changed: true }>;
};

test("stack: three turns give three branches, each one commit on the one below, under one stack name", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "Add due dates to tasks", "1"));
  assert.equal(c1.branch, "feat/add-due-dates-to-tasks/1-add-due-dates-to-tasks");
  assert.equal(c1.change.position, 1);
  assert.equal(c1.change.baseSha, main);
  const c2 = ok(await t.change(c1.branch, c1.sha, "Dark mode", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Add CSV export", "3"));
  assert.equal(c2.branch, "feat/add-due-dates-to-tasks/2-dark-mode");
  assert.equal(c3.branch, "feat/add-due-dates-to-tasks/3-add-csv-export");
  assert.equal(c3.stack.id, c1.stack.id);
  // A straight chain: each commit's parent is the change below's.
  assert.equal(t.provider.commits.get(c1.sha)!.parent, main);
  assert.equal(t.provider.commits.get(c2.sha)!.parent, c1.sha);
  assert.equal(t.provider.commits.get(c3.sha)!.parent, c2.sha);
  assert.equal(t.provider.refs.get(c2.branch), c2.sha);
  assert.equal(t.provider.refs.get("main"), main); // the default branch doesn't move

  const [s] = await readStacks(t.ctx);
  assert.equal(s.name, "add-due-dates-to-tasks");
  assert.equal(s.baseSha, main);
  assert.deepEqual(s.changes.map((c) => [c.position, c.title, c.github]), [[1, "Add due dates to tasks", "ok"], [2, "Dark mode", "ok"], [3, "Add CSV export", "ok"]]);
  assert.equal(s.changes[0].prompt, "Add due dates to tasks, please");
  assert.equal(s.changes[0].author, "octo");
});

test("stack: a turn that changes nothing leaves no branch and no change", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const before = [...t.provider.refs.keys()];
  assert.deepEqual(await t.change("main", main, "Explain the code", "<h1>hi</h1>"), { changed: false, sha: main });
  assert.deepEqual([...t.provider.refs.keys()], before);
  assert.deepEqual(await readStacks(t.ctx), []);
});

test("stack: a stack's top change takes the next change; a change below it doesn't; any other branch starts a stack", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const code = (e: unknown) => (e as HttpError).code;
  // Below the top (another browser added one since): refused, nothing made.
  const refs = t.provider.refs.size;
  await assert.rejects(t.change(c1.branch, c1.sha, "Three", "3"), (e) => code(e) === "not_on_top" && /below its top/.test((e as Error).message));
  await assert.rejects(t.change(c2.branch, c1.sha, "Three", "3"), (e) => code(e) === "not_on_stack"); // not where it's recorded
  assert.equal(t.provider.refs.size, refs);
  // A branch of its own (an older feature branch): a stack from its commit.
  const own = t.provider.push("main", { "x": "y" });
  t.provider.refs.set("feat/older", own);
  t.provider.refs.set("main", main);
  const o1 = ok(await t.change("feat/older", own, "Go on", "o"));
  assert.deepEqual([o1.branch, o1.change.baseSha], ["feat/go-on/1-go-on", own]);
  // From the default branch again: a second stack, the first left as it is.
  const other = ok(await t.change("main", main, "Another thing", "x"));
  assert.notEqual(other.stack.id, c1.stack.id);
  const stacks = await readStacks(t.ctx);
  // (Newest first; these can share a millisecond.)
  assert.deepEqual(stacks.map((s) => [s.name, s.changes.length]).sort(), [["another-thing", 1], ["go-on", 1], ["one", 2]]);
});

test("stack: a name in the way picks the next one, and the commit isn't made twice", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  t.provider.refs.set("feat/dark-mode", main); // the single-branch flow's name: a folder can't be made under it
  const c1 = ok(await t.change("main", main, "Dark mode", "1"));
  assert.equal(c1.branch, "feat/dark-mode-2/1-dark-mode");
  assert.equal(c1.stack.name, "dark-mode-2");
  t.provider.refs.set("feat/dark-mode-2/2-bluer", main);
  const made = t.provider.commits.size;
  const c2 = ok(await t.change(c1.branch, c1.sha, "Bluer", "2"));
  assert.equal(c2.branch, "feat/dark-mode-2/2-bluer-2");
  assert.equal(t.provider.commits.size, made + 1);
  // An open stack's name isn't reused even when its branches are free.
  const c3 = ok(await t.change("main", main, "Dark mode", "3"));
  assert.equal(c3.stack.name, "dark-mode-3");
});

test("stack: reading it says which branches moved or are gone on GitHub", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const pushed = t.provider.push(c1.branch, { "x.txt": "outside" });
  t.provider.refs.delete(c2.branch);
  const [s] = await readStacks(t.ctx);
  assert.deepEqual(s.changes.map((c) => [c.github, c.headSha]), [["moved", pushed], ["gone", undefined]]);
});

test("stack: a commit onto the top change follows it; one onto a change below doesn't", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const x = "f".repeat(40);
  assert.equal(await t.store.followStackTop(t.app.id, c1.branch, c1.sha, x), false);
  assert.equal(await t.store.followStackTop(t.app.id, c2.branch, "e".repeat(40), x), false); // not from where it's recorded
  assert.equal(await t.store.followStackTop(t.app.id, c2.branch, c2.sha, x), true);
  const [s] = await t.store.openStackChanges(t.app.id).then((cs) => [cs.find((c) => c.position === 2)!]);
  assert.equal(s.sha, x);
});

test("stack: merging the top change lands the stack, and the branches below go while they're at their change", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  const moved = t.provider.push(c2.branch, { "y.txt": "a push from outside" });
  // Not at its recorded commit: nothing lands.
  assert.equal(await landed(t.ctx, { branch: c3.branch, headSha: "e".repeat(40), mergedSha: c3.sha, deleteBelow: true }), null);
  assert.deepEqual(await landed(t.ctx, { branch: c3.branch, headSha: c3.sha, mergedSha: c3.sha, deleteBelow: true }), { stack: "one", changes: 3, deleted: [c1.branch, c3.branch] });
  assert.deepEqual(await readStacks(t.ctx), []);
  assert.equal(t.provider.refs.has(c1.branch), false);
  assert.equal(t.provider.refs.get(c2.branch), moved); // pushed to since: kept
  assert.equal(t.provider.refs.has(c3.branch), false); // the merged one too (the stack's cleanup decides about it)
  const rows = await t.store.db.all<{ state: string; landed_sha: string }>("SELECT state, landed_sha FROM stack_changes ORDER BY position");
  assert.deepEqual(rows.map((r) => [r.state, r.landed_sha]), [["landed", c3.sha], ["landed", c3.sha], ["landed", c3.sha]]);

  // A change added on top while the merge ran (the merged one was the top when it was allowed): the merged one and
  // those below it land, the new one stays open; without deleteBelow (the merged files didn't load), the branches
  // below stay.
  const e1 = ok(await t.change("main", main, "Six", "6"));
  const e2 = ok(await t.change(e1.branch, e1.sha, "Seven", "7"));
  const e3 = ok(await t.change(e2.branch, e2.sha, "Eight", "8"));
  assert.deepEqual(await landed(t.ctx, { branch: e2.branch, headSha: e2.sha, mergedSha: e2.sha, deleteBelow: true }), { stack: "six", changes: 2, deleted: [e1.branch, e2.branch] });
  assert.deepEqual((await readStacks(t.ctx)).find((x) => x.id === e3.stack.id)!.changes.map((c) => c.title), ["Eight"]);
  assert.equal(t.provider.refs.has(e1.branch), false);
  const f1 = ok(await t.change("main", main, "Nine", "9"));
  const f2 = ok(await t.change(f1.branch, f1.sha, "Ten", "10"));
  await landed(t.ctx, { branch: f2.branch, headSha: f2.sha, mergedSha: f2.sha, deleteBelow: false });
  assert.equal(t.provider.refs.get(f1.branch), f1.sha);

  // With the app's delete-branch setting off, every branch stays.
  const d1 = ok(await t.change("main", main, "Four", "4"));
  const d2 = ok(await t.change(d1.branch, d1.sha, "Five", "5"));
  await landed({ ...t.ctx, repo: { ...t.repo, delete_branch: 0 } }, { branch: d2.branch, headSha: d2.sha, mergedSha: d2.sha, deleteBelow: true });
  assert.equal(t.provider.refs.get(d1.branch), d1.sha);
});

test("stack: a change below its stack's top can't be merged on its own", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await assert.rejects(assertNotBelowTop(t.ctx, c1.branch), (e) => (e as HttpError).code === "not_on_top");
  await assertNotBelowTop(t.ctx, c2.branch);
  await assertNotBelowTop(t.ctx, "feat/anything");
});

test("stack: going back sets the changes above aside; restore puts them back; building on it drops them for good", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  const code = (e: unknown) => (e as HttpError).code;

  const back = await goBack(t.ctx, c1.change.id);
  assert.deepEqual([back.change.sha, back.setAside.map((c) => c.title)], [c1.sha, ["Two", "Three"]]);
  let [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes.map((c) => c.title), s.setAside.map((c) => c.title)], [["One"], ["Two", "Three"]]);
  assert.equal(t.provider.refs.get(c3.branch), c3.sha); // branches kept
  // Change 1 is the top now: a change set aside takes nothing, and can't be committed to or merged.
  await assert.rejects(t.change(c3.branch, c3.sha, "Four", "4"), (e) => code(e) === "set_aside");
  await assert.rejects(assertNotBelowTop(t.ctx, c2.branch), (e) => code(e) === "set_aside");
  await assertNotBelowTop(t.ctx, c1.branch);

  // Restore: back as they were.
  assert.equal((await restore(t.ctx, s.id)).change.id, c3.change.id);
  [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes.map((c) => c.title), s.setAside], [["One", "Two", "Three"], []]);
  await assert.rejects(restore(t.ctx, s.id), (e) => code(e) === "nothing_set_aside");

  // Back again, then a new change on 1: it's change 2 (its name taken by the one set aside, so -2), and the ones set
  // aside can't come back.
  await goBack(t.ctx, c1.change.id);
  const n2 = ok(await t.change(c1.branch, c1.sha, "Two", "2b"));
  assert.deepEqual([n2.change.position, n2.branch], [2, "feat/one/2-two-2"]);
  assert.equal(t.provider.commits.get(n2.sha)!.parent, c1.sha);
  [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes.map((c) => c.title), s.setAside], [["One", "Two"], []]);
  await assert.rejects(restore(t.ctx, s.id), (e) => code(e) === "nothing_set_aside");
  assert.equal(t.provider.refs.get(c2.branch), c2.sha); // still on GitHub
  await assert.rejects(goBack(t.ctx, c3.change.id), (e) => code(e) === "not_found"); // not open
});

test("stack: after going back, a commit onto the change (a pushed edit) builds on it too; a landed stack restores nothing", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  const code = (e: unknown) => (e as HttpError).code;
  // Going back twice: every change set aside is listed (the AI builder is told of them all).
  await goBack(t.ctx, c2.change.id);
  assert.deepEqual((await goBack(t.ctx, c1.change.id)).setAside.map((c) => c.title), ["Two", "Three"]);
  // A hand edit pushed onto change 1: it follows, and the ones set aside can't come back (they don't hold it).
  const pushed = t.provider.push(c1.branch, { "x.txt": "hand" });
  await followed(t.ctx, c1.branch, c1.sha, pushed);
  let [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes.map((c) => c.sha), s.setAside], [[pushed], []]);
  await assert.rejects(restore(t.ctx, s.id), (e) => code(e) === "nothing_set_aside");
  void c3;

  // Gone back to 1 of 2, then 1 landed: nothing to restore onto.
  const d1 = ok(await t.change("main", main, "Four", "4"));
  const d2 = ok(await t.change(d1.branch, d1.sha, "Five", "5"));
  await goBack(t.ctx, d1.change.id);
  await landed(t.ctx, { branch: d1.branch, headSha: d1.sha, mergedSha: d1.sha, deleteBelow: true });
  const stackId = d2.stack.id;
  await assert.rejects(restore(t.ctx, stackId), (e) => code(e) === "nothing_set_aside" && /isn't open/.test((e as Error).message));
  [s] = await readStacks(t.ctx);
  assert.notEqual(s?.id, stackId);
});

test("stack: go back and restore check the commit the caller saw; an undo restores only what its go back set aside", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  const code = (e: unknown) => (e as HttpError).code;
  await assert.rejects(goBack(t.ctx, c1.change.id, "e".repeat(40)), (e) => code(e) === "conflict");
  await goBack(t.ctx, c2.change.id); // 3 set aside
  const back = await goBack(t.ctx, c1.change.id, c1.sha); // then 2
  assert.deepEqual([back.now, back.setAside.map((c) => c.title)], [[c2.change.id], ["Two", "Three"]]);
  // Undone: only 2 comes back; 3 stays set aside, restorable.
  const undo = await restore(t.ctx, c3.stack.id, { only: back.now });
  assert.deepEqual([undo.change.id, undo.below.id], [c2.change.id, c1.change.id]);
  let [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes.map((c) => c.title), s.setAside.map((c) => c.title)], [["One", "Two"], ["Three"]]);
  // `only` restores from the bottom of the ones set aside, never one above another left aside.
  await goBack(t.ctx, c1.change.id); // 2 set aside below 3
  await assert.rejects(restore(t.ctx, s.id, { only: [c3.change.id] }), (e) => code(e) === "conflict");
  await restore(t.ctx, s.id, { only: [c2.change.id] });
  // Undoing a restore names the top it expects: one added since stops it.
  await assert.rejects(goBack(t.ctx, c1.change.id, c1.sha, { id: c3.change.id, sha: c3.sha }), (e) => code(e) === "conflict");
  await goBack(t.ctx, c1.change.id, c1.sha, { id: c2.change.id, sha: c2.sha });
  await restore(t.ctx, s.id, { only: [c2.change.id] });
  [s] = await readStacks(t.ctx);
  // Restore names the top it'll load: another one (or another commit) is refused.
  await assert.rejects(restore(t.ctx, s.id, { top: { id: c2.change.id, sha: c2.sha } }), (e) => code(e) === "conflict");
  await assert.rejects(restore(t.ctx, s.id, { top: { id: c3.change.id, sha: "e".repeat(40) } }), (e) => code(e) === "conflict");
  assert.equal((await restore(t.ctx, s.id, { top: { id: c3.change.id, sha: c3.sha } })).restored, 1);

  // A commit on the top that the record couldn't follow (its branch had moved): it's still built on, nothing restorable.
  await goBack(t.ctx, c2.change.id);
  await t.ctx.store.db.run("UPDATE stack_changes SET sha = ? WHERE id = ?", "e".repeat(40), c2.change.id);
  await followed(t.ctx, c2.branch, c2.sha, "f".repeat(40));
  [s] = await readStacks(t.ctx);
  assert.deepEqual(s.setAside, []);
});

test("stack: submitting opens a pull request per change, each on the branch below, with the stack's table", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "Due dates", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Dark | mode", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "CSV export", "3"));
  const id = c1.stack.id;
  const r = await submitStack(t.ctx, id);
  assert.deepEqual(r.pulls.map((x) => [x.position, x.number, x.created, x.error]), [[1, 1, true, undefined], [2, 2, true, undefined], [3, 3, true, undefined]]);
  const pr = t.provider.pulls;
  assert.deepEqual(pr.map((x) => [x.head, x.base, x.title]), [[c1.branch, "main", "Due dates"], [c2.branch, c1.branch, "Dark | mode"], [c3.branch, c2.branch, "CSV export"]]);
  assert.equal(pr[1].body, [
    "> Dark | mode, please",
    "",
    "**Stack `due-dates`**: one pull request per AI builder request in Cresslet, each based on the one below it, so this one shows only its own change.",
    "",
    "| | Change | Pull request |",
    "| --- | --- | --- |",
    "|  | 3 · CSV export | #3 |",
    "| → | 2 · Dark \\| mode | #2 |",
    "|  | 1 · Due dates | #1 |",
    "| | `main` | |",
  ].join("\n"));
  assert.deepEqual((await readStacks(t.ctx))[0].changes.map((c) => c.pull), [1, 2, 3]);
  assert.deepEqual(Object.keys(await stackPulls(t.ctx, id)).length, 3);

  // Again, with a fourth change: nothing duplicated, one more, every table refreshed.
  const c4 = ok(await t.change(c3.branch, c3.sha, "Four", "4"));
  const again = await submitStack(t.ctx, id);
  assert.deepEqual(again.pulls.map((x) => [x.number, x.created]), [[1, false], [2, false], [3, false], [4, true]]);
  assert.equal(pr.length, 4);
  assert.match(pr[0].body, /\| {2}\| 4 · Four \| #4 \|/);
  assert.equal(pr[3].base, c3.branch);
  void c4;
});

test("stack: an open pull request from a change's branch is reused (on the right base); one refused doesn't stop the others", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  await t.provider.createPull(t.ctx.r, { head: c1.branch, base: "develop", title: "by hand", body: "" }); // #1, on another base
  t.provider.refuse.add(c2.branch);
  const r = await submitStack(t.ctx, c1.stack.id);
  assert.deepEqual(r.pulls.map((x) => [x.position, x.number ?? null, !!x.error]), [[1, 1, false], [2, null, true], [3, 2, false]]);
  assert.match(r.pulls[1].error!, /Validation Failed/);
  assert.deepEqual(t.provider.pulls.map((x) => [x.head, x.base]), [[c1.branch, "main"], [c3.branch, c2.branch]]);
  // Fixed on GitHub's side: submitting again opens the missing one.
  t.provider.refuse.clear();
  assert.deepEqual((await submitStack(t.ctx, c1.stack.id)).pulls.map((x) => x.number), [1, 3, 2]);
});

test("stack: a pull request merged by hand is said, not opened again; a reused one takes the change's title; @names don't notify", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await commitChange(t.ctx, { from: "main", baseSha: main, files: [["index.html", new TextEncoder().encode("1")]], title: "One", prompt: "ask @octo-cat about it", author: { name: "octo", email: "o@x" }, by: null }));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await t.provider.createPull(t.ctx.r, { head: c2.branch, base: c1.branch, title: "by hand", body: "" });
  await submitStack(t.ctx, c1.stack.id);
  assert.deepEqual(t.provider.pulls.map((x) => [x.head, x.title]), [[c2.branch, "Two"], [c1.branch, "One"]]);
  assert.match(t.provider.pulls[1].body, /^> ask @\u200bocto-cat about it/);
  t.provider.pulls[1].merged = true;
  t.provider.pulls[1].state = "closed";
  t.provider.pulls[0].base = "main"; // GitHub moved it on when the one below merged
  const again = await submitStack(t.ctx, c1.stack.id);
  assert.deepEqual(again.pulls.map((x) => [x.number, !!x.merged, x.error]), [[2, true, undefined], [1, false, undefined]]);
  assert.equal(t.provider.pulls.length, 2);
  // The change above one merged already: its base is left as it was (landing part of a stack is a later step).
  assert.equal(t.provider.pulls[0].base, "main");
  // Source control's view of a change: a merged one is shown (not offered again), a closed one isn't, a set-aside
  // one has none, another branch isn't a change.
  assert.equal((await changePull(t.ctx, c1.branch, false))?.pull?.number, 2);
  t.provider.pulls[0].state = "closed";
  assert.equal((await changePull(t.ctx, c2.branch, false))?.pull, null);
  await goBack(t.ctx, c1.change.id);
  assert.deepEqual(await changePull(t.ctx, c2.branch, false), { pull: null });
  await assert.rejects(changePull(t.ctx, c2.branch, true), (e) => (e as HttpError).code === "set_aside");
  assert.equal(await changePull(t.ctx, "feat/other", false), null);
});

test("stack: going back closes the set-aside changes' pull requests; restore reopens them", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  await submitStack(t.ctx, c1.stack.id);
  await goBack(t.ctx, c1.change.id);
  assert.deepEqual(t.provider.pulls.map((x) => x.state), ["open", "closed", "closed"]);
  // Submitting the stack now: only the open change has a pull request.
  assert.deepEqual((await submitStack(t.ctx, c1.stack.id)).pulls.map((x) => x.number), [1]);
  await restore(t.ctx, c1.stack.id);
  assert.deepEqual(t.provider.pulls.map((x) => x.state), ["open", "open", "open"]);
  // One opened from a change's branch before its number was recorded is closed too (and reopened).
  const c4 = ok(await t.change(c3.branch, c3.sha, "Four", "4"));
  await t.provider.createPull(t.ctx.r, { head: c4.branch, base: c3.branch, title: "Four", body: "" });
  await goBack(t.ctx, c3.change.id);
  assert.equal(t.provider.pulls[3].state, "closed");
  await restore(t.ctx, c1.stack.id);
  assert.equal(t.provider.pulls[3].state, "open");
});

test("stack: a change pushed to on GitHub is pulled in as the top (the ones above set aside for good), or carried on from as a branch", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const code = (e: unknown) => (e as HttpError).code;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  await submitStack(t.ctx, c1.stack.id);
  const pushed = t.provider.push(c2.branch, { "x.txt": "from outside" });
  let [s] = await readStacks(t.ctx);
  assert.deepEqual(s.changes.map((c) => c.github), ["ok", "moved", "ok"]);
  await assert.rejects(pullIn(t.ctx, c2.change.id, "e".repeat(40)), (e) => code(e) === "conflict"); // not what GitHub has
  const r = await pullIn(t.ctx, c2.change.id, pushed);
  assert.deepEqual([r.change.sha, r.dropped], [pushed, 1]);
  [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes.map((c) => [c.title, c.github]), s.setAside], [[["One", "ok"], ["Two", "ok"]], []]);
  assert.equal(t.provider.pulls[2].state, "closed");
  assert.equal(t.provider.refs.get(c3.branch), c3.sha); // kept
  const n3 = ok(await t.change(c2.branch, pushed, "Three again", "3b"));
  assert.equal(t.provider.commits.get(n3.sha)!.parent, pushed);

  // Taken in already (another tab replaying it): refused, nothing above it touched.
  await assert.rejects(pullIn(t.ctx, c2.change.id, pushed), (e) => code(e) === "conflict");
  assert.equal((await readStacks(t.ctx))[0].changes.length, 3);
  // A turn on a top pushed to since: refused, so the push isn't left out (from a workspace that hasn't seen it, or one
  // that pulled it in by hand).
  const again = t.provider.push(n3.branch, { "w.txt": "pushed again" });
  await assert.rejects(t.change(n3.branch, n3.sha, "Four", "4"), (e) => code(e) === "moved");
  await assert.rejects(t.change(n3.branch, again, "Four", "4"), (e) => code(e) === "moved");

  // Carried on from (change 2): the stack ends, all of it, the ones set aside too; its branch takes commits as one branch.
  const other = t.provider.push(c2.branch, { "y.txt": "more from outside" });
  const left = await carryOn(t.ctx, c2.change.id, other);
  assert.equal(left.left, 3);
  assert.deepEqual(await readStacks(t.ctx), []);
  await assert.rejects(t.change(c2.branch, other, "Four", "4"), (e) => code(e) === "not_on_stack");
  await assert.rejects(t.change(c1.branch, c1.sha, "Four", "4"), (e) => code(e) === "not_on_stack");
});

test("stack: carrying on from a change with ones set aside above: they can't come back over it", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  await goBack(t.ctx, c2.change.id);
  const pushed = t.provider.push(c2.branch, { "x": "outside" });
  await carryOn(t.ctx, c2.change.id, pushed);
  await assert.rejects(restore(t.ctx, c1.stack.id), (e) => (e as HttpError).code === "nothing_set_aside");
  assert.deepEqual((await setAsideBranches(t.ctx)).map((c) => [c.title, c.restorable]), [["Three", false]]);
});

test("stack: changes set aside are listed and deleted (with the ones above them); a landed stack's go with it", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  const c4 = ok(await t.change(c3.branch, c3.sha, "Four", "4"));
  await goBack(t.ctx, c1.change.id);
  assert.deepEqual((await setAsideBranches(t.ctx)).map((c) => [c.title, c.restorable]).sort(), [["Four", true], ["Three", true], ["Two", true]]);
  // Deleting 3 takes 4 with it; 4 was pushed to: kept (said), and out of the stack, since 3 below it is gone.
  t.provider.push(c4.branch, { "z.txt": "pushed" });
  let d = await deleteSetAside(t.ctx, c3.change.id);
  assert.deepEqual([d.dropped, d.kept.map((k) => k.position)], [[c3.change.id], [4]]);
  assert.equal(t.provider.refs.has(c3.branch), false);
  assert.deepEqual((await setAsideBranches(t.ctx)).map((c) => [c.title, c.restorable]).sort(), [["Four", false], ["Two", true]]);
  t.provider.refs.set(c4.branch, c4.sha);
  t.provider.keep.add(c4.branch); // GitHub refuses the delete: kept, said
  d = await deleteSetAside(t.ctx, c4.change.id);
  assert.deepEqual([d.dropped, d.kept.map((k) => k.error)], [[], [`GitHub didn't delete ${c4.branch}`]]);
  t.provider.keep.clear();
  d = await deleteSetAside(t.ctx, c4.change.id);
  assert.deepEqual(d.dropped, [c4.change.id]);
  assert.deepEqual((await setAsideBranches(t.ctx)).map((c) => c.title), ["Two"]);
  assert.equal((await restore(t.ctx, c1.stack.id)).change.id, c2.change.id);

  // Deleting the one set aside and building on: the new change takes its place.
  await goBack(t.ctx, c1.change.id);
  await deleteSetAside(t.ctx, c2.change.id);
  const n2 = ok(await t.change(c1.branch, c1.sha, "Two again", "2b"));
  assert.equal(n2.change.position, 2);
  await goBack(t.ctx, c1.change.id); // n2 set aside, to land below

  // Landing change 1: its ones set aside go (the app deletes merged branches); another stack's don't.
  const other = ok(await t.change("main", main, "Elsewhere", "e1"));
  ok(await t.change(other.branch, other.sha, "Elsewhere 2", "e2"));
  await goBack(t.ctx, other.change.id);
  await landed(t.ctx, { branch: c1.branch, headSha: c1.sha, mergedSha: c1.sha, deleteBelow: true });
  assert.equal(t.provider.refs.has(n2.branch), false);
  assert.deepEqual((await setAsideBranches(t.ctx)).map((c) => c.title), ["Elsewhere 2"]);
});

test("stack: at its most changes, a turn joins the top change and says so", async () => {
  await using t = await setup();
  let from = "main", sha = t.provider.refs.get("main")!, id = "";
  for (let i = 1; i <= MAX_STACK; i++) {
    const c = ok(await t.change(from, sha, `Change ${i}`, String(i)));
    [from, sha, id] = [c.branch, c.sha, c.stack.id];
  }
  const j = ok(await t.change(from, sha, "One more", "more"));
  assert.deepEqual([j.joined, j.branch, j.change.position], [true, from, MAX_STACK]);
  assert.equal(t.provider.refs.get(from), j.sha);
  // The top's branch deleted on GitHub: the next one joins it all the same, its branch made again.
  t.provider.refs.delete(from);
  const k = ok(await t.change(from, j.sha, "And another", "another"));
  assert.deepEqual([k.joined, t.provider.refs.get(from)], [true, k.sha]);
  const j2 = k;
  const [s] = await readStacks(t.ctx);
  assert.deepEqual([s.id, s.changes.length, s.changes.at(-1)!.sha], [id, MAX_STACK, j2.sha]);
  // An undo would join it too (under the top's title): refused.
  await assert.rejects(undoPlan(t.ctx, s.changes[0].id), (e) => (e as HttpError).code === "stack_full");
});

test("stack: landing up to a change moves the default branch to it change by change; each pull request merged with its own turn", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  await submitStack(t.ctx, c1.stack.id);
  const pr = t.provider.pulls;
  const l = await landUpTo(t.ctx, c2.change.id);
  assert.deepEqual([l.sha, l.landed.map((c) => c.title)], [c2.sha, ["One", "Two"]]);
  assert.equal(t.provider.refs.get("main"), c2.sha);
  assert.deepEqual(pr.map((x) => [x.state, x.merged, x.base]), [["closed", true, "main"], ["closed", true, "main"], ["open", false, "main"]]);
  assert.equal(t.provider.refs.has(c1.branch) || t.provider.refs.has(c2.branch), false); // landed branches go
  assert.equal(t.provider.refs.get(c3.branch), c3.sha);
  const [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes.map((c) => c.title), s.baseSha], [["Three"], c2.sha]);
  const rows = await t.store.db.all<{ title: string; state: string; landed_sha: string }>("SELECT title, state, landed_sha FROM stack_changes ORDER BY position");
  assert.deepEqual(rows.map((x) => [x.title, x.state, x.landed_sha]), [["One", "landed", c1.sha], ["Two", "landed", c2.sha], ["Three", "open", null]]);
  // The rest: change 3 lands on its own.
  await landUpTo(t.ctx, c3.change.id);
  assert.deepEqual([t.provider.refs.get("main"), pr[2].merged], [c3.sha, true]);
  assert.deepEqual(await readStacks(t.ctx), []);
});

test("stack: on a protected default branch, Land next merges the bottom's pull request through GitHub; the next one is then on the default branch", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const code = (e: unknown) => (e as HttpError).code;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  t.provider.guarded.add("main");
  await submitStack(t.ctx, c1.stack.id);
  const pr = t.provider.pulls;
  // Deploy (landing up to the top) says what's left, and moves nothing.
  await assert.rejects(landUpTo(t.ctx, c3.change.id), (e) => code(e) === "branch_protected" && /changes 1–3 are left to land.*Land next/.test((e as Error).message) && (e as HttpError).extra?.left === 3);
  // Only the bottom lands; GitHub refusing (review, checks, rules) is said with its reason, nothing changes.
  await assert.rejects(landNext(t.ctx, c2.change.id), (e) => code(e) === "not_bottom");
  t.provider.unmergeable.set(1, "At least 1 approving review is required by reviewers with write access.");
  await assert.rejects(landNext(t.ctx, c1.change.id), (e) => code(e) === "merge_refused" && /approving review/.test((e as Error).message));
  assert.deepEqual([(await readStacks(t.ctx))[0].changes.length, t.provider.refs.get("main"), pr[1].base], [3, main, c1.branch]);
  t.provider.unmergeable.clear();
  // The change as the caller saw it.
  await assert.rejects(landNext(t.ctx, c1.change.id, "f".repeat(40)), (e) => code(e) === "conflict");

  // Merged: pull request 2 on main (its own turn only), change 1's branch gone, change 2's pull request read again
  // (pointing it at main dismissed its approval).
  t.provider.status.set(2, { review: "pending" });
  const l = await landNext(t.ctx, c1.change.id, c1.sha);
  assert.deepEqual([pr[0].merged, t.provider.refs.get("main"), l.sha, pr[1].base, t.provider.refs.has(c1.branch)], [true, l.sha, l.sha, "main", false]);
  assert.deepEqual([l.next?.change, l.next?.pull?.review, l.deleted], [c2.change.id, "pending", [c1.branch]]);
  let [s] = await readStacks(t.ctx);
  assert.deepEqual(s.changes.map((c) => c.position), [2, 3]);

  // Its pull request not on main (a landing that left it on the branch below): refused, nothing moved (moving it may
  // dismiss its approval; Update pull requests does it).
  t.provider.pulls[1].base = c1.branch;
  await assert.rejects(landNext(t.ctx, c2.change.id), (e) => code(e) === "pull_base");
  t.provider.pulls[1].base = "main";
  // GitHub's own "delete branch on merge" did both already: fine.
  t.provider.gh.deleteOnMerge = true;
  const l2 = await landNext(t.ctx, c2.change.id);
  assert.deepEqual([l2.deleted, l2.pullErrors, pr[2].base, t.provider.refs.has(c2.branch)], [[], undefined, "main", false]);
  [s] = await readStacks(t.ctx);
  assert.deepEqual(s.changes.map((c) => c.position), [3]);
  // Merged on GitHub already, its branch deleted with it: recorded as landed (into main only).
  // (A merge commit on main holding change 3, then more merged since: the landing is at its merge commit.)
  const squash = t.provider.push("main", { merged: "3" });
  t.provider.refs.set("tmp", c3.sha);
  const mergeSha = t.provider.push("tmp", { merged: "3" });
  t.provider.refs.set("main", mergeSha);
  t.provider.push("main", { later: "x" });
  Object.assign(pr[2], { base: c2.branch, state: "closed", merged: true, mergeSha, mergedHead: c3.sha });
  await assert.rejects(landNext(t.ctx, c3.change.id), (e) => code(e) === "merged_elsewhere");
  pr[2].base = "main";
  // Merged at an earlier commit (a push since): not landed.
  pr[2].mergedHead = c2.sha;
  await assert.rejects(landNext(t.ctx, c3.change.id), (e) => code(e) === "merged_elsewhere" && /another commit/.test((e as Error).message));
  pr[2].mergedHead = c3.sha;
  // main reset since (it doesn't hold the change any more): not recorded.
  const kept = t.provider.refs.get("main")!;
  t.provider.refs.set("main", squash);
  await assert.rejects(landNext(t.ctx, c3.change.id), (e) => code(e) === "merged_elsewhere" && /reset/.test((e as Error).message));
  t.provider.refs.set("main", kept);
  t.provider.refs.delete(c3.branch);
  const l3 = await landNext(t.ctx, c3.change.id);
  assert.equal(l3.sha, mergeSha);
  assert.deepEqual(await readStacks(t.ctx), []);
});

test("stack: Land next needs merge commits or squash (rebase-only refused), a pull request, and the bottom at its commit; Update merges the default branch into it", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const code = (e: unknown) => (e as HttpError).code;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await assert.rejects(landNext(t.ctx, c1.change.id), (e) => code(e) === "no_pull");
  await submitStack(t.ctx, c1.stack.id);
  Object.assign(t.provider.methods, { merge: false, squash: false });
  await assert.rejects(landNext(t.ctx, c1.change.id), (e) => code(e) === "merge_method" && /only allows rebase merges/.test((e as Error).message));
  Object.assign(t.provider.methods, { merge: true, squash: true });
  t.provider.push(c1.branch, { x: "outside" });
  await assert.rejects(landNext(t.ctx, c1.change.id), (e) => code(e) === "moved");
  t.provider.refs.set(c1.branch, c1.sha);

  // Behind main (it must be up to date): main merged into change 1, which is at that commit then.
  const moved = t.provider.push("main", { "other.txt": "o" });
  await assert.rejects(updateBottom(t.ctx, c2.change.id), (e) => code(e) === "not_bottom");
  const u = await updateBottom(t.ctx, c1.change.id, c1.sha);
  assert.notEqual(u.change.sha, c1.sha);
  assert.deepEqual([t.provider.refs.get(c1.branch), t.provider.commits.get(u.change.sha)!.files.get("other.txt")], [u.change.sha, "o"]);
  const [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes[0].sha, s.changes[0].github, s.changes[1].sha], [u.change.sha, "ok", c2.sha]);
  assert.ok(moved);
  const l = await landNext(t.ctx, c1.change.id, u.change.sha);
  assert.equal(t.provider.refs.get("main"), l.sha);
});

test("stack: squash-only, Land next squashes the bottom and gives the next change one sync commit (its files as they are) before its pull request moves onto main", async () => {
  await using t = await setup();
  const code = (e: unknown) => (e as HttpError).code;
  const author = { name: "octo", email: "o@x" };
  const base = { "index.html": "<h1>hi</h1>", "a.txt": "a", "b.txt": "b", "c.txt": "c" };
  const main0 = t.provider.push("main", base);
  const put = (from: string, baseSha: string, title: string, files: Record<string, string>) => commitChange(t.ctx, {
    from, baseSha, title, prompt: "", author, by: null,
    files: Object.entries(files).map(([p, d]) => [p, new TextEncoder().encode(d)] as [string, Uint8Array]),
  }).then(ok);
  const c1 = await put("main", main0, "A", { ...base, "a.txt": "a1" });
  const c2 = await put(c1.branch, c1.sha, "B", { ...base, "a.txt": "a1", "b.txt": "b2" });
  const c3 = await put(c2.branch, c2.sha, "C", { ...base, "a.txt": "a1", "b.txt": "b2", "c.txt": "c3" });
  await submitStack(t.ctx, c1.stack.id);
  t.provider.guarded.add("main");
  Object.assign(t.provider.methods, { merge: false, squash: true, rebase: false });
  const pr = t.provider.pulls;

  const l1 = await landNext(t.ctx, c1.change.id);
  const s1 = t.provider.commits.get(l1.sha)!;
  assert.deepEqual([s1.parent, s1.parent2, pr[0].merged], [main0, undefined, true]); // a squash: one commit on main
  // Change 2: one sync commit (main's squash as its second parent, its files unchanged), recorded; then on main.
  let [s] = await readStacks(t.ctx);
  const sync = t.provider.commits.get(s.changes[0].sha)!;
  assert.deepEqual([sync.parent, sync.parent2, s.changes[0].github, s.changes[0].baseSha], [c2.sha, l1.sha, "ok", l1.sha]);
  assert.deepEqual([...sync.files], [...t.provider.commits.get(c2.sha)!.files]);
  assert.equal(pr[1].base, "main");
  // Change 3 is left alone until it's the bottom, and the stack isn't behind for it (it holds what 2 was synced from).
  assert.equal(s.changes[1].sha, c3.sha);
  assert.equal(s.behind, undefined);
  await assertLinked(t.ctx, s.changes[1].id);
  assert.deepEqual((await restack(t.ctx, c1.stack.id)).updated, []);
  // …but folding it into change 2 would put its pull request on main without the squash: refused, as is landing
  // past change 2 as fast-forwards.
  await assert.rejects(fold(t.ctx, s.changes[1].id, s.changes[0].id), (e) => code(e) === "stack_behind" && /sync commit/.test((e as Error).message));
  t.provider.guarded.delete("main");
  await assert.rejects(landUpTo(t.ctx, s.changes[1].id), (e) => code(e) === "stack_behind" && /land up to change 2 first/.test((e as Error).message));
  t.provider.guarded.add("main");

  // main moved meanwhile (another commit): refused before the squash (Update stack first).
  const before = t.provider.refs.get("main")!;
  t.provider.push("main", { "d.txt": "d" });
  await assert.rejects(landNext(t.ctx, s.changes[0].id), (e) => code(e) === "stack_behind");
  assert.equal(pr[1].merged, false);
  t.provider.refs.set("main", before);

  // main brought into change 2 only ("Update branch"): change 3 doesn't hold that, so its sync would undo it: refused.
  const moved = t.provider.push("main", { "e.txt": "e" });
  const up = await updateBottom(t.ctx, s.changes[0].id);
  await assert.rejects(landNext(t.ctx, s.changes[0].id), (e) => code(e) === "stack_behind" && /doesn't hold change 2/.test((e as Error).message));
  assert.equal(pr[1].merged, false);
  // Update stack brings it into change 3; then it lands.
  assert.deepEqual((await restack(t.ctx, c1.stack.id)).updated.map((x) => x.position), [3]);
  assert.ok(moved && up);
  [s] = await readStacks(t.ctx);
  const l2 = await landNext(t.ctx, s.changes[0].id);
  [s] = await readStacks(t.ctx);
  assert.deepEqual([t.provider.commits.get(s.changes[0].sha)!.parent2, pr[2].base, t.provider.refs.get("main")], [l2.sha, "main", l2.sha]);
  await landNext(t.ctx, s.changes[0].id);
  assert.deepEqual(await readStacks(t.ctx), []);
  assert.equal(t.provider.commits.get(t.provider.refs.get("main")!)!.files.get("c.txt"), "c3");
});

test("stack: Update stack merges the default branch into each change from the bottom up; stops at a conflict, carries on once it's resolved; then lands as a fast-forward", async () => {
  await using t = await setup();
  const code = (e: unknown) => (e as HttpError).code;
  const author = { name: "octo", email: "o@x" };
  const base = { "index.html": "<h1>hi</h1>", "a.txt": "a", "b.txt": "b", "c.txt": "c" };
  const main0 = t.provider.push("main", base);
  const put = (from: string, baseSha: string, title: string, files: Record<string, string>) => commitChange(t.ctx, {
    from, baseSha, title, prompt: "", author, by: null,
    files: Object.entries(files).map(([p, d]) => [p, new TextEncoder().encode(d)] as [string, Uint8Array]),
  }).then(ok);
  const c1 = await put("main", main0, "A", { ...base, "a.txt": "a1" });
  const c2 = await put(c1.branch, c1.sha, "B", { ...base, "a.txt": "a1", "b.txt": "b2" });
  const c3 = await put(c2.branch, c2.sha, "C", { ...base, "a.txt": "a1", "b.txt": "b2", "c.txt": "c3" });
  assert.equal((await readStacks(t.ctx))[0].behind, undefined);

  // main moved (another file): each change gets one merge commit; each holds the one below (its pull request: its own turn).
  t.provider.push("main", { "d.txt": "d" });
  assert.equal((await readStacks(t.ctx))[0].behind, true);
  const u = await restack(t.ctx, c1.stack.id);
  assert.deepEqual([u.updated.map((x) => x.position), u.stopped], [[1, 2, 3], undefined]);
  let [s] = await readStacks(t.ctx);
  assert.equal(s.behind, undefined);
  assert.deepEqual(s.changes.map((x) => [x.github, t.provider.commits.get(x.sha)!.files.get("d.txt"), t.provider.refs.get(x.branch) === x.sha]), [["ok", "d", true], ["ok", "d", true], ["ok", "d", true]]);
  assert.deepEqual(s.changes.map((x, i) => t.provider.commits.get(x.sha)!.parent), [c1.sha, c2.sha, c3.sha]);
  assert.equal((await restack(t.ctx, c1.stack.id)).updated.length, 0); // nothing to do again
  // Undo still works on an updated change (its base is now the commit merged in).
  const un = await undoPlan(t.ctx, s.changes[0].id);
  assert.equal(un.files.find((f) => f.path === "a.txt")?.data, "a");

  // main changes b.txt, as change 2 did: change 1 merges, change 2 stops with its conflict, change 3 is left as it was.
  t.provider.push("main", { "b.txt": "b-main" });
  const v = await restack(t.ctx, c1.stack.id);
  assert.deepEqual([v.updated.map((x) => x.position), v.stopped?.change.position, v.stopped?.with, v.stopped?.paths], [[1], 2, c1.branch, ["b.txt"]]);
  [s] = await readStacks(t.ctx);
  assert.deepEqual([s.changes[0].sha, v.stopped?.withSha, s.changes[1].sha, s.changes[2].sha], [v.updated[0].sha, v.updated[0].sha, u.updated[1].sha, u.updated[2].sha]);
  // Stopped part way: still said (change 1 holds main, change 2 not change 1), and landing past it refused unmoved.
  assert.equal(s.behind, true);
  const mainNow = t.provider.refs.get("main");
  await assert.rejects(landUpTo(t.ctx, s.changes[2].id), (e) => code(e) === "stack_behind");
  assert.equal(t.provider.refs.get("main"), mainNow);
  // …and merging the top as one (Deploy's fallback): it doesn't hold change 1's merge.
  await assert.rejects(assertLinked(t.ctx, s.changes[2].id), (e) => code(e) === "stack_behind");
  // …and folding change 2 into change 1 (it doesn't hold change 1's merge: folding would drop it).
  await assert.rejects(fold(t.ctx, s.changes[1].id, s.changes[0].id), (e) => code(e) === "stack_behind");
  // Resolved in the workspace and committed onto change 2 (below the top: only as that merge), its record following.
  await assert.rejects(assertSyncable(t.ctx, s.changes[1].branch, "f".repeat(40)), (e) => code(e) === "not_on_top");
  // (Not onto a change below the top that holds that merge already: change 1 holds main.)
  await assert.rejects(assertSyncable(t.ctx, s.changes[0].branch, main0), (e) => code(e) === "not_on_top");
  const at = await assertSyncable(t.ctx, s.changes[1].branch, v.stopped!.withSha);
  assert.equal(at?.id, s.changes[1].id);
  const resolved = await t.provider.commitTree(t.ctx.r, {
    branch: s.changes[1].branch, baseSha: s.changes[1].sha, subdir: "", message: "Merge", author, mergeParent: v.stopped!.withSha,
    files: Object.entries({ ...base, "a.txt": "a1", "b.txt": "b-both", "d.txt": "d" }).map(([p, d]) => [p, new TextEncoder().encode(d)] as [string, Uint8Array]),
  });
  await t.store.setStackChangeSha(at!.id, resolved.sha);
  // Run again: carries on with change 3.
  const w = await restack(t.ctx, c1.stack.id);
  assert.deepEqual([w.updated.map((x) => x.position), w.stopped], [[3], undefined]);
  [s] = await readStacks(t.ctx);
  assert.equal(t.provider.commits.get(s.changes[2].sha)!.files.get("b.txt"), "b-both");

  // Changes set aside above a top that Update stack moves can't come back (they don't hold the merge).
  await goBack(t.ctx, s.changes[1].id);
  assert.equal((await readStacks(t.ctx))[0].setAside.length, 1);
  t.provider.push("main", { "e.txt": "e" });
  assert.deepEqual((await restack(t.ctx, c1.stack.id)).updated.map((x) => x.position), [1, 2]);
  assert.equal((await readStacks(t.ctx))[0].setAside.length, 0);
  [s] = await readStacks(t.ctx);

  // Landing after the update: main moves to each change as a fast-forward.
  const l = await landUpTo(t.ctx, s.changes[1].id);
  assert.equal(t.provider.refs.get("main"), s.changes[1].sha);
  assert.equal(l.landed.length, 2);
});

test("stack: recorded landed, then looked at again (Deploy's one merge): the set-aside branches go too", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await goBack(t.ctx, c1.change.id);
  const merged = t.provider.push("main", { x: "y" });
  assert.equal((await landed(t.ctx, { branch: c1.branch, headSha: c1.sha, mergedSha: merged, deleteBelow: false }))?.changes, 1);
  assert.equal(t.provider.refs.has(c2.branch), true);
  await landed(t.ctx, { branch: c1.branch, headSha: c1.sha, mergedSha: merged, deleteBelow: true });
  assert.deepEqual([t.provider.refs.has(c1.branch), t.provider.refs.has(c2.branch)], [false, false]);
});

test("stack: landing is refused before anything moves on a protected default branch, one that moved, or a change pushed to", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const code = (e: unknown) => (e as HttpError).code;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  t.provider.guarded.add("main");
  await assert.rejects(landUpTo(t.ctx, c2.change.id), (e) => code(e) === "branch_protected" && /through their pull requests/.test((e as Error).message));
  t.provider.guarded.clear();
  const pushed = t.provider.push(c1.branch, { x: "outside" });
  await assert.rejects(landUpTo(t.ctx, c2.change.id), (e) => code(e) === "moved");
  t.provider.refs.set(c1.branch, c1.sha);
  void pushed;
  const teammate = t.provider.push("main", { y: "teammate" });
  await assert.rejects(landUpTo(t.ctx, c2.change.id), (e) => code(e) === "default_moved");
  assert.equal(t.provider.refs.get("main"), teammate);
  assert.equal((await readStacks(t.ctx))[0].changes.length, 2);
});

test("stack: a landing that stops half way is recorded, and landing again carries on (no pull request closed unmerged)", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  await submitStack(t.ctx, c1.stack.id);
  t.provider.failUpdate.add(2); // retargeting change 2's pull request fails
  await assert.rejects(landUpTo(t.ctx, c3.change.id), (e) => (e as HttpError).code === "github_error");
  assert.equal(t.provider.refs.get("main"), c1.sha); // change 1 landed, nothing after it
  assert.deepEqual(t.provider.pulls.map((x) => [x.state, x.merged]), [["closed", true], ["open", false], ["open", false]]);
  assert.deepEqual((await readStacks(t.ctx))[0].changes.map((c) => c.title), ["Two", "Three"]);
  await landUpTo(t.ctx, c3.change.id);
  assert.equal(t.provider.refs.get("main"), c3.sha);
  assert.deepEqual(t.provider.pulls.map((x) => x.merged), [true, true, true]);
  assert.equal(t.provider.refs.has(c1.branch), false); // landed by the run that stopped: deleted by this one

  // Moved but not recorded (stopped between the two): taken as landed, and carried on from.
  const d1 = ok(await t.change("main", c3.sha, "Four", "4"));
  const d2 = ok(await t.change(d1.branch, d1.sha, "Five", "5"));
  t.provider.refs.set("main", d1.sha);
  const l = await landUpTo(t.ctx, d2.change.id);
  assert.deepEqual([l.sha, (await readStacks(t.ctx)).length], [d2.sha, 0]);
});

test("stack: a landed branch the next change's pull request is still on stays, also when Deploy merges it again", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await submitStack(t.ctx, c1.stack.id);
  t.provider.failUpdate.add(2);
  await landUpTo(t.ctx, c1.change.id);
  await landed(t.ctx, { branch: c1.branch, headSha: c1.sha, mergedSha: c1.sha, deleteBelow: true });
  assert.deepEqual([t.provider.refs.get(c1.branch), t.provider.pulls[1].state], [c1.sha, "open"]);
});

test("stack: the change above's pull request not on the default branch yet: its base branch stays, and goes on the next landing", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await submitStack(t.ctx, c1.stack.id);
  t.provider.failUpdate.add(2);
  const l = await landUpTo(t.ctx, c1.change.id);
  assert.deepEqual([l.sha, l.pullErrors?.map((x) => x.position)], [c1.sha, [2]]);
  assert.equal(t.provider.refs.get(c1.branch), c1.sha); // kept: PR #2 is still on it
  assert.deepEqual(t.provider.pulls[1].state, "open");
  await landUpTo(t.ctx, c2.change.id);
  assert.deepEqual([t.provider.pulls[1].merged, t.provider.refs.has(c1.branch)], [true, false]);
});

test("stack: a change to land whose branch is gone on GitHub isn't landed; one landed further already counts", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  t.provider.refs.delete(c2.branch);
  await assert.rejects(landUpTo(t.ctx, c3.change.id), (e) => (e as HttpError).code === "branch_not_found");
  assert.equal(t.provider.refs.get("main"), main);
  t.provider.refs.set(c2.branch, c2.sha);
  t.provider.refs.set("main", c3.sha); // landed past it elsewhere
  const l = await landUpTo(t.ctx, c1.change.id);
  assert.deepEqual([l.landed.map((c) => c.title), l.sha], [["One", "Two", "Three"], c3.sha]);
  assert.deepEqual(await readStacks(t.ctx), []);
});

test("stack: merged in one merge, a submitted stack's branches under pull requests left open are kept (the top's too), and said", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await submitStack(t.ctx, c1.stack.id);
  const r = await landed(t.ctx, { branch: c2.branch, headSha: c2.sha, mergedSha: "e".repeat(40), deleteBelow: true });
  // #1 (on main) and #2 (on change 1's branch) are open: everything kept, nothing closed unmerged.
  assert.deepEqual([r?.deleted, r?.pullErrors?.map((x) => x.position).sort()], [[], [1, 2]]);
  assert.deepEqual([t.provider.refs.has(c1.branch), t.provider.refs.has(c2.branch)], [true, true]);
});

test("stack: landed branches: a newer pull request from a branch whose recorded one closed is seen; one unreadable keeps them all; a merge run again doesn't delete unseen", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await submitStack(t.ctx, c1.stack.id);
  t.provider.pulls[1].state = "closed"; // #2 closed by hand, then another opened from the same branch
  await t.provider.createPull(t.ctx.r, { head: c2.branch, base: c1.branch, title: "again", body: "" });
  let r = await landed(t.ctx, { branch: c2.branch, headSha: c2.sha, mergedSha: "e".repeat(40), deleteBelow: true });
  assert.deepEqual([t.provider.refs.has(c1.branch), t.provider.refs.has(c2.branch)], [true, true]);
  assert.ok(r?.pullErrors?.some((x) => /#3 is still open/.test(x.error)));
  // Merged again (Deploy run again): still kept while #3 is open; gone once it's closed.
  r = await landed(t.ctx, { branch: c2.branch, headSha: c2.sha, mergedSha: "e".repeat(40), deleteBelow: true });
  assert.deepEqual([r?.changes, r?.deleted, t.provider.refs.has(c2.branch)], [0, [], true]);
  t.provider.pulls[0].state = "closed";
  t.provider.pulls[2].state = "closed";
  // One pull request that can't be read: nothing of the stack is deleted this time.
  const real = t.provider.getPull;
  t.provider.getPull = async () => { throw new HttpError(502, "GitHub: Server Error", "github_error"); };
  r = await landed(t.ctx, { branch: c2.branch, headSha: c2.sha, mergedSha: "e".repeat(40), deleteBelow: true });
  assert.deepEqual([r?.deleted, t.provider.refs.has(c1.branch)], [[], true]);
  t.provider.getPull = real;
  r = await landed(t.ctx, { branch: c2.branch, headSha: c2.sha, mergedSha: "e".repeat(40), deleteBelow: true });
  assert.deepEqual(r?.deleted.sort(), [c1.branch, c2.branch].sort());
});

test("stack: the default branch moved past changes outside Cresslet with their pull requests still open: their branches are kept, and said", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  await submitStack(t.ctx, c1.stack.id);
  t.provider.refs.set("main", c3.sha); // fast-forwarded on GitHub, not through the stack: PR #1 merged, #2 and #3 open
  Object.assign(t.provider.pulls[0], { state: "closed", merged: true });
  const l = await landUpTo(t.ctx, c3.change.id);
  assert.deepEqual(l.landed.map((c) => c.title), ["One", "Two", "Three"]);
  assert.deepEqual(l.pullErrors?.map((x) => x.position).sort(), [2, 3]);
  assert.deepEqual([t.provider.refs.has(c1.branch), t.provider.refs.has(c2.branch), t.provider.refs.has(c3.branch)], [true, true, true]); // (1 is #2's base)
  assert.deepEqual(t.provider.pulls.map((x) => x.state), ["closed", "open", "open"]);
});

test("stack: landing a stack never submitted (no pull requests), with GitHub having deleted a landed branch already", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  // (Deleted after main moved to it: GitHub's "delete branch on merge".)
  const real = t.provider.moveBranch;
  t.provider.moveBranch = async (r, b, from, to) => {
    await real(r, b, from, to);
    if (to === c1.sha) t.provider.refs.delete(c1.branch);
  };
  const l = await landUpTo(t.ctx, c2.change.id);
  assert.deepEqual([l.sha, t.provider.refs.get("main"), t.provider.pulls.length, l.deleted], [c2.sha, c2.sha, 0, [c2.branch]]);
});

test("stack: folding change 3 into 2 leaves a stack of two; its pull request takes 2's base, 2's is closed with a note", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Bluer", "3"));
  await submitStack(t.ctx, c1.stack.id);
  const pr = t.provider.pulls;
  const f = await fold(t.ctx, c3.change.id, c2.change.id);
  assert.deepEqual([f.change.position, f.change.title, f.change.baseSha, f.change.branch, f.dropped], [2, "Two", c1.sha, c3.branch, c2.change.id]);
  assert.equal(f.change.prompt, "Two, please\n\nBluer, please");
  const [s] = await readStacks(t.ctx);
  assert.deepEqual(s.changes.map((c) => [c.position, c.title, c.branch]), [[1, "One", c1.branch], [2, "Two", c3.branch]]);
  // Its diff against change 1 holds both turns: change 3's commit sits on change 2's.
  assert.equal(t.provider.commits.get(c3.sha)!.parent, c2.sha);
  assert.deepEqual(pr.map((x) => [x.state, x.base, x.title]), [["open", "main", "One"], ["closed", c1.branch, "Two"], ["open", c1.branch, "Two"]]);
  assert.deepEqual(t.provider.comments, [{ n: 2, body: `Folded into #3 (Cresslet): ${c3.branch} now holds this change and the one that was above it.` }]);
  assert.equal(t.provider.refs.has(c2.branch), false);
  assert.match(pr[0].body, /\| {2}\| 2 · Two \| #3 \|\n\| → \| 1 · One \| #1 \|/); // tables refreshed
});

test("stack: folding with changes set aside above: restored, they follow with no gap; a fold confirmed against another change below is refused", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  ok(await t.change(c3.branch, c3.sha, "Four", "4"));
  await goBack(t.ctx, c3.change.id); // 4 set aside
  await assert.rejects(fold(t.ctx, c3.change.id, c1.change.id), (e) => (e as HttpError).code === "conflict"); // 2 is below it
  await fold(t.ctx, c3.change.id, c2.change.id);
  await restore(t.ctx, c1.stack.id);
  const [s] = await readStacks(t.ctx);
  assert.deepEqual(s.changes.map((c) => [c.position, c.title]), [[1, "One"], [2, "Two"], [3, "Four"]]);
  // Run again (a retry): it isn't folded one further down.
  await assert.rejects(fold(t.ctx, c3.change.id, c2.change.id), (e) => (e as HttpError).code === "conflict");
});

test("stack: a pull request opened by hand from the upper branch is the one kept; with none to point at, the lower one isn't closed", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  await t.provider.createPull(t.ctx.r, { head: c2.branch, base: c1.branch, title: "by hand", body: "" });
  const f = await fold(t.ctx, c2.change.id, c1.change.id);
  assert.deepEqual([f.change.pull, t.provider.pulls[0].base, t.provider.pulls[0].title], [1, "main", "One"]);
  assert.equal(t.provider.refs.has(c1.branch), false);

  // The lower one has a pull request; one can't be opened for the upper one: the lower one and its branch stay.
  const d1 = ok(await t.change(f.change.branch, f.change.sha, "Three", "3"));
  const d2 = ok(await t.change(d1.branch, d1.sha, "Four", "4"));
  await t.provider.createPull(t.ctx.r, { head: d1.branch, base: f.change.branch, title: "Three", body: "" });
  t.provider.refuse.add(d2.branch);
  const g = await fold(t.ctx, d2.change.id, d1.change.id);
  assert.ok(g.pullErrors?.some((x) => /is kept open/.test(x.error)));
  assert.deepEqual([t.provider.pulls.find((x) => x.head === d1.branch)?.state, t.provider.refs.has(d1.branch)], ["open", true]);
});

test("stack: folding publishes nothing else: only the remaining change's pull request is opened or refreshed; long prompts keep the newest", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  await t.provider.createPull(t.ctx.r, { head: c3.branch, base: c2.branch, title: "by hand", body: "" });
  await fold(t.ctx, c3.change.id, c2.change.id);
  assert.deepEqual(t.provider.pulls.map((x) => [x.head, x.base, x.title]), [[c3.branch, c1.branch, "Two"]]); // change 1 not published
  // Change 1's recorded pull request closed, a newer one opened from its branch: that one's table is refreshed.
  await submitStack(t.ctx, c1.stack.id);
  Object.assign(t.provider.pulls.find((x) => x.head === c1.branch)!, { state: "closed" });
  await t.provider.createPull(t.ctx.r, { head: c1.branch, base: "main", title: "newer", body: "stale" });
  const c4 = ok(await t.change(c3.branch, c3.sha, "Four", "4"));
  await fold(t.ctx, c4.change.id, c3.change.id);
  assert.match(t.provider.pulls.at(-2)!.body, /\| → \| 1 · One \|/);
  const [s] = await readStacks(t.ctx);
  const row = (await t.store.openStackChanges(t.app.id)).find((x) => x.id === c4.change.id)!;
  const body = pullBody({ ...row, prompt: `${"a".repeat(25000)}\n\nthe newest request` }, [row], new Map(), "main");
  assert.ok(body.includes("the newest request") && body.length < 25000);
  void s;
});

test("stack: folding a change with no pull request onto one that has one: it gets one on that base", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const c1 = ok(await t.change("main", main, "One", "1"));
  await submitStack(t.ctx, c1.stack.id);
  const c2 = ok(await t.change(c1.branch, c1.sha, "Bluer", "2"));
  await fold(t.ctx, c2.change.id, c1.change.id);
  assert.deepEqual(t.provider.pulls.map((x) => [x.head, x.base, x.state, x.title]), [[c1.branch, "main", "closed", "One"], [c2.branch, "main", "open", "One"]]);
  assert.deepEqual(t.provider.comments.map((x) => x.body.split(" (")[0]), ["Folded into #2"]);
});

test("stack: folding moves the changes above down; never the bottom, nor one set aside; never submitted works too; refused, nothing changes", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const code = (e: unknown) => (e as HttpError).code;
  const c1 = ok(await t.change("main", main, "One", "1"));
  const c2 = ok(await t.change(c1.branch, c1.sha, "Two", "2"));
  const c3 = ok(await t.change(c2.branch, c2.sha, "Three", "3"));
  const c4 = ok(await t.change(c3.branch, c3.sha, "Four", "4"));
  await assert.rejects(fold(t.ctx, c1.change.id, ""), (e) => code(e) === "bottom");
  await goBack(t.ctx, c3.change.id); // 4 set aside
  await assert.rejects(fold(t.ctx, c4.change.id, c3.change.id), (e) => code(e) === "not_found");
  await restore(t.ctx, c1.stack.id);
  const f = await fold(t.ctx, c2.change.id, c1.change.id); // never submitted
  assert.deepEqual([f.pullErrors, t.provider.pulls.length], [undefined, 0]);
  let [s] = await readStacks(t.ctx);
  assert.deepEqual(s.changes.map((c) => [c.position, c.title, c.baseSha]), [[1, "One", main], [2, "Three", c2.sha], [3, "Four", c3.sha]]);
  assert.equal(t.provider.refs.has(c1.branch), false);
  // A next change goes on top at the next position.
  const c5 = ok(await t.change(c4.branch, c4.sha, "Five", "5"));
  assert.equal(c5.change.position, 4);
  // Its pull request can't be moved onto the base: refused, nothing changes.
  await submitStack(t.ctx, s.id);
  t.provider.failUpdate.add(t.provider.pulls.find((x) => x.head === c4.branch)!.number);
  await assert.rejects(fold(t.ctx, c4.change.id, c3.change.id), (e) => code(e) === "github_error");
  [s] = await readStacks(t.ctx);
  assert.equal(s.changes.length, 4);
  assert.equal(t.provider.refs.get(c3.branch), c3.sha);
});

test("stack: undoing change 1 of 3 (the others touched other files): the top without change 1's files, no conflicts", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  const put = (from: string, baseSha: string, title: string, files: Record<string, string>) => commitChange(t.ctx, {
    from, baseSha, title, prompt: "", author: { name: "octo", email: "o@x" }, by: null,
    files: Object.entries({ "index.html": "<h1>hi</h1>", ...files }).map(([p, d]) => [p, new TextEncoder().encode(d)] as [string, Uint8Array]),
  }).then(ok);
  const c1 = await put("main", main, "Add a", { "a.txt": "a1" });
  const c2 = await put(c1.branch, c1.sha, "Add b", { "a.txt": "a1", "b.txt": "b" });
  const c3 = await put(c2.branch, c2.sha, "Add c", { "a.txt": "a1", "b.txt": "b", "c.txt": "c" });
  const u = await undoPlan(t.ctx, c1.change.id);
  assert.deepEqual([u.title, u.top, u.conflicts], ["Undo: Add a", { branch: c3.branch, sha: c3.sha }, []]);
  assert.deepEqual(u.files.map((f) => f.path), ["b.txt", "c.txt", "index.html"]); // a.txt gone, the rest kept
  // Committed from the top as a change of its own: change 4, "Undo: Add a"; 2 and 3 untouched.
  const c4 = await put(c3.branch, c3.sha, u.title, { "b.txt": "b", "c.txt": "c" });
  assert.deepEqual([c4.change.position, c4.change.title], [4, "Undo: Add a"]);
  assert.equal(t.provider.refs.get(c2.branch), c2.sha);

  // A later change touched the same file: it comes back with markers.
  const d1 = await put(c4.branch, c4.sha, "Set x", { "b.txt": "b", "c.txt": "c", "x.txt": "one" });
  const d2 = await put(d1.branch, d1.sha, "Change x", { "b.txt": "b", "c.txt": "c", "x.txt": "two" });
  const v = await undoPlan(t.ctx, d1.change.id);
  assert.deepEqual(v.conflicts, ["x.txt"]);
  assert.match(v.files.find((f) => f.path === "x.txt")!.data, /^<<<<<<< now\ntwo\n=======\n\n>>>>>>> undo change 5\n$/);
  // The top change: undone by going back instead.
  await assert.rejects(undoPlan(t.ctx, d2.change.id), (e) => (e as HttpError).code === "top");
});

test("stack: unlinking or relinking the app forgets its stacks", async () => {
  await using t = await setup();
  const main = t.provider.refs.get("main")!;
  ok(await t.change("main", main, "One", "1"));
  await t.store.setAppRepo({ ...t.repo, repo_id: "2" });
  assert.deepEqual(await t.store.openStackChanges(t.app.id), []);
  ok(await t.change("main", main, "Two", "2"));
  await t.store.deleteAppRepo(t.app.id);
  assert.deepEqual(await t.store.openStackChanges(t.app.id), []);
});

test("stack: branch name parts", () => {
  assert.equal(slug("Add a dark-mode toggle to the header, please!"), "add-a-dark-mode-toggle-to-the");
  assert.equal(slug("!!!"), "change");
});
