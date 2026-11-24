// One owning tab per project (#154): two tabs of one project would run two containers and save whole snapshots over
// each other. A tab takes the project's Web Lock before it loads the snapshot and starts the workspace; another tab
// waits for it (showing the project read-only) and takes over, from what the owner last committed, when it closes.
// The owner's writes go through one queue (one at a time, in order); in-app it lets go only after they've committed.
// Without Web Locks every tab owns (as before). No DOM here: under Node, tests/project_lock_test.ts.

/** What this needs of `navigator.locks` (passed in under Node). */
export interface Locks {
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, granted: (lock: unknown) => unknown): Promise<unknown>;
}

export const lockName = (id: string) => `cresslet.project.${id}`;

const defaultLocks = () => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks ?? null;

export interface WriteQueue {
  /** Runs `write` once the ones queued before it have settled; settles as it does. */
  run<T>(write: () => Promise<T>): Promise<T>;
  /** Resolves once everything queued, including what's queued meanwhile, has settled. */
  idle(): Promise<void>;
}

export function writeQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(write) {
      const r = tail.then(write);
      tail = r.catch(() => {}); // a failed write doesn't hold up the next
      return r;
    },
    async idle() {
      for (let t = tail; ; t = tail) {
        await t;
        if (t === tail) return;
      }
    },
  };
}

const queues = new Map<string, WriteQueue>();
/** The project's writes from this tab (snapshots, its deploy, its repository): one at a time, in the order asked. */
export function projectWrites(id: string) {
  let q = queues.get(id);
  if (!q) queues.set(id, q = writeQueue());
  return q;
}

/** The projects this tab owns now. */
const owned = new Set<string>();
/** Whether this tab owns the project (the only one that may run it and save it). */
export const ownsProject = (id: string) => owned.has(id);

/** The project's last lock in this tab, until it let go: the next one here waits for it (not shown as another tab's). */
const local = new Map<string, Promise<void>>();

export interface ProjectLock {
  /** True once this tab owns the project (at once without Web Locks); false if released before that. */
  readonly owned: Promise<boolean>;
  readonly owner: boolean;
  /**
   * Lets go (or stops waiting), once this tab's queued writes to the project have committed: the workspace queues its
   * final save as it goes, in the same commit as this or just after. Resolves when it's let go.
   */
  release(): Promise<void>;
}

/** Takes the project's lock; `blocked` is called if another tab holds it (this one waits in line). */
export function lockProject(id: string, { locks = defaultLocks(), blocked }: { locks?: Locks | null; blocked?: () => void } = {}): ProjectLock {
  let owner = false, released = false;
  let letGo!: () => void, settle!: (owned: boolean) => void;
  const hold = new Promise<void>((r) => (letGo = r));
  const isOwned = new Promise<boolean>((r) => (settle = r));
  const abort = new AbortController();
  const granted = (lock: unknown) => {
    if (!lock || released) return; // held elsewhere (ifAvailable), or let go meanwhile
    owner = true;
    owned.add(id);
    settle(true);
    return hold;
  };
  const before = local.get(id);
  const done: Promise<void> = (async () => {
    await before;
    if (released) return;
    if (!locks) {
      await granted(true); // every tab owns
      return;
    }
    let got = false;
    await locks.request(lockName(id), { ifAvailable: true }, (lock) => (got = !!lock, granted(lock)));
    if (got || released) return;
    blocked?.();
    await locks.request(lockName(id), { signal: abort.signal }, granted);
  })().catch(() => {}).finally(() => { // (AbortError: released while waiting)
    if (owner) owned.delete(id);
    owner = false;
    settle(false);
    if (local.get(id) === done) local.delete(id);
  });
  local.set(id, done);
  return {
    owned: isOwned,
    get owner() {
      return owner;
    },
    release() {
      if (!released) {
        released = true;
        if (!owner) settle(false);
        abort.abort();
        void new Promise((r) => setTimeout(r)).then(() => projectWrites(id).idle()).finally(letGo);
      }
      return done;
    },
  };
}
