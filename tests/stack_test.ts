// Stacked changes (server/stack.ts) over a fake source control provider: no network, no GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../server/deploys.ts";
import type { CommitInput, Pull, Repo, SourceControlProvider } from "../server/git.ts";
import { assertNotBelowTop, commitChange, type Ctx, followed, goBack, landed, readStacks, restore, slug, stackPulls, submitStack } from "../server/stack.ts";
import { type AppRepo, Store } from "../server/store.ts";

/** Branches and commits in memory: a commit is its files and its parent. */
function fakeProvider() {
  const commits = new Map<string, { files: Map<string, string>; parent: string | null }>();
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
  const pulls: (Pull & { title: string; body: string })[] = [];
  const refuse = new Set<string>(); // branches GitHub won't open a pull request from
  const pullOf = (n: number) => {
    const x = pulls[n - 1];
    if (!x) throw new HttpError(404, "not found on GitHub", "git_not_found");
    return x;
  };
  const p: SourceControlProvider & {
    refs: Map<string, string>; commits: typeof commits; pulls: typeof pulls; refuse: Set<string>; push(branch: string, files: Record<string, string>): string;
  } = {
    refs, commits, pulls, refuse,
    async getPull(_r: Repo, n: number) {
      return { ...pullOf(n) };
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
      Object.assign(pullOf(n), Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)));
      return { ...pullOf(n) };
    },
    async pullStatus(_r: Repo, n: number) {
      const x = pullOf(n);
      return { number: n, url: x.url, title: x.title, draft: false, headSha: refs.get(x.head) ?? "", review: "approved" as const, checks: "success" as const };
    },
    push(branch, files) {
      const head = refs.get(branch)!;
      const sha = make(new Map([...commits.get(head)!.files, ...Object.entries(files)]), head);
      refs.set(branch, sha);
      return sha;
    },
    listRepos: no, createRepo: no, repo: no, listBranches: no, readTree: no, merge: no,
    async branchHead(_r: Repo, branch: string) {
      return refs.get(branch) ?? null;
    },
    async createBranch(_r: Repo, branch: string, sha: string) {
      if (taken(branch)) throw new HttpError(409, `branch ${branch} already exists`, "branch_exists");
      refs.set(branch, sha);
    },
    async deleteBranch(_r: Repo, branch: string) {
      return refs.delete(branch);
    },
    async commitTree(_r: Repo, input: CommitInput) {
      const base = commits.get(input.baseSha)!;
      const files = new Map(input.files.map(([path, d]) => [path, new TextDecoder().decode(d)]));
      const same = files.size === base.files.size && [...files].every(([k, v]) => base.files.get(k) === v);
      if (same) return { sha: input.baseSha, changed: false };
      const sha = make(files, input.baseSha);
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
  assert.deepEqual(await landed(t.ctx, { branch: c3.branch, headSha: c3.sha, mergedSha: c3.sha, deleteBelow: true }), { stack: "one", changes: 3 });
  assert.deepEqual(await readStacks(t.ctx), []);
  assert.equal(t.provider.refs.has(c1.branch), false);
  assert.equal(t.provider.refs.get(c2.branch), moved); // pushed to since: kept
  assert.equal(t.provider.refs.has(c3.branch), true); // the merge route deletes the merged branch itself
  const rows = await t.store.db.all<{ state: string; landed_sha: string }>("SELECT state, landed_sha FROM stack_changes ORDER BY position");
  assert.deepEqual(rows.map((r) => [r.state, r.landed_sha]), [["landed", c3.sha], ["landed", c3.sha], ["landed", c3.sha]]);

  // A change added on top while the merge ran (the merged one was the top when it was allowed): the merged one and
  // those below it land, the new one stays open; without deleteBelow (the merged files didn't load), the branches
  // below stay.
  const e1 = ok(await t.change("main", main, "Six", "6"));
  const e2 = ok(await t.change(e1.branch, e1.sha, "Seven", "7"));
  const e3 = ok(await t.change(e2.branch, e2.sha, "Eight", "8"));
  assert.deepEqual(await landed(t.ctx, { branch: e2.branch, headSha: e2.sha, mergedSha: e2.sha, deleteBelow: true }), { stack: "six", changes: 2 });
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
  const again = await submitStack(t.ctx, c1.stack.id);
  assert.deepEqual(again.pulls.map((x) => [x.number, !!x.merged, x.error]), [[2, true, undefined], [1, false, undefined]]);
  assert.equal(t.provider.pulls.length, 2);
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
