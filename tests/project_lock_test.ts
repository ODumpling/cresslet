// One owning tab per project (studio/project-lock.ts): saves through the write queue commit in the order they were
// asked for, and the project's Web Lock (Node's navigator.locks here) hands over only after the owner's writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { lockProject, ownsProject, projectWrites, writeQueue, type Locks } from "../studio/project-lock.ts";

/** A save as the workspace does it: an export that takes a while, then a put of the whole snapshot. */
function saver(committed: string[]) {
  return (files: string, exportMs: number) => async () => {
    await sleep(exportMs);
    committed.push(files);
  };
}

test("write queue: overlapping saves commit in the order asked, the last one last", async () => {
  // Unqueued, the slower first export commits after the second: the older snapshot wins.
  const raw: string[] = [];
  const save = saver(raw);
  await Promise.all([save("v1", 30)(), save("v2", 1)()]);
  assert.deepEqual(raw, ["v2", "v1"]);

  const committed: string[] = [];
  const q = writeQueue(), put = saver(committed);
  await Promise.all([q.run(put("v1", 30)), q.run(put("v2", 1)), q.run(put("v3", 10))]);
  assert.deepEqual(committed, ["v1", "v2", "v3"]);
});

test("write queue: a failed write doesn't stop the next; idle waits for writes queued meanwhile", async () => {
  const q = writeQueue(), committed: string[] = [];
  const failed = q.run(async () => {
    await sleep(5);
    throw new Error("quota");
  });
  const next = q.run(async () => void committed.push("after"));
  await assert.rejects(failed, /quota/);
  await next;
  assert.deepEqual(committed, ["after"]);

  void q.run(async () => {
    await sleep(10);
    void q.run(async () => { // queued while the first runs (a save asked for during a save)
      await sleep(10);
      committed.push("late");
    });
  });
  await q.idle();
  assert.deepEqual(committed, ["after", "late"]);
});

test("project lock: a second tab waits (told it's held), and takes over only after the owner's final save", async () => {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const a = lockProject(id);
  assert.equal(await a.owned, true);
  assert.equal(ownsProject(id), true);

  // Another tab (its own lock manager in the browser; here the same one, from outside this tab's line).
  let blocked = false;
  const locks = (globalThis as { navigator: { locks: Locks } }).navigator.locks;
  let otherOwns = false, otherGone!: () => void;
  const other = locks.request(`cresslet.project.${id}`, {}, () => {
    otherOwns = true;
    return new Promise<void>((r) => (otherGone = r));
  });
  void locks.request(`cresslet.project.${id}`, { ifAvailable: true }, (l) => void (blocked = !l));
  await sleep(5);
  assert.equal(blocked, true);
  assert.equal(otherOwns, false);

  // The owner leaves in-app: its final save is queued as it goes, and the lock waits for it.
  const committed: string[] = [];
  const released = a.release();
  void projectWrites(id).run(async () => {
    await sleep(30);
    committed.push("final");
  });
  await sleep(10);
  assert.equal(otherOwns, false, "handed over before the final save committed");
  await released;
  assert.deepEqual(committed, ["final"]);
  assert.equal(ownsProject(id), false);
  await sleep(5);
  assert.equal(otherOwns, true);

  // This tab again, while the other owns it: blocked, then owner once it closes.
  let told = false;
  const b = lockProject(id, { blocked: () => (told = true) });
  await sleep(5);
  assert.equal(told, true);
  assert.equal(b.owner, false);
  otherGone();
  await other;
  assert.equal(await b.owned, true);
  await b.release();
});

test("project lock: released while waiting, it never owns; this tab's own locks queue without saying 'blocked'", async () => {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const a = lockProject(id);
  let told = false;
  const b = lockProject(id, { blocked: () => (told = true) }); // (React's StrictMode remounts, or back to it at once)
  assert.equal(await a.owned, true);
  await sleep(5);
  assert.equal(told, false);
  const c = lockProject(id);
  void b.release();
  assert.equal(await b.owned, false);
  await a.release();
  assert.equal(await c.owned, true);
  await c.release();
});

test("project lock: without Web Locks every tab owns (as before)", async () => {
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const a = lockProject(id, { locks: null });
  assert.equal(await a.owned, true);
  assert.equal(ownsProject(id), true);
  await a.release();
  assert.equal(ownsProject(id), false);
});
