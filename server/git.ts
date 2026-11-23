// Source control (docs/architecture.md#source-control): apps sync with a GitHub repository through this server, as
// the signed-in user. Each account connects its own GitHub identity (a GitHub App's user-to-server token, or with
// CRESSLET_GITHUB_SYNC_OAUTH_FALLBACK the login OAuth App with the `repo` scope); its tokens are sealed at rest
// (Store.upsertGitConnection) and never leave the server. Every call uses the acting account's own token, never the
// app owner's, so GitHub's permissions and attribution are that user's. Commits go through the Git Data API (blobs,
// trees, commits, refs): there's no `git` here or in the studio's container.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type Config, rootUrl } from "./config.ts";
import type { Env } from "./admin.ts";
import { type DeployFile, deploySource, DOTENV, HttpError, mergeDotenvText, NOT_SOURCE, publicDotenv, safePath, sourceFiles } from "./deploys.ts";
import {
  assertNotBelowTop, assertSyncable, carryOn, changePull, type PullError, commitChange, deleteSetAside, fold, followed, undoPlan, goBack, landed, landNext, landUpTo, locked, pullIn, readStacks, restore,
  restack, setAsideBranches, stackPulls, submitStack, updateBottom,
} from "./stack.ts";
import { type Account, type App, type AppRepo, type GitConnection, type GitProvider, id, type Role, type Store } from "./store.ts";

/** Refresh an access token this long before it expires. */
const REFRESH_EARLY_MS = 5 * 60_000;
const STATE_TTL = 10 * 60_000;
const SHA_RE = /^[0-9a-f]{40}$/;
/** Branch names Cresslet creates or accepts: git's ref rules, a little stricter. */
const BRANCH_RE = /^(?!\/|.*(?:\/\/|\.\.|@\{|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._\/-]{1,200}(?<![/.])$/;
const REPO_PART_RE = /^[\w.-]{1,100}$/;

export interface RepoInfo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  /** The acting user can push to it. */
  push: boolean;
}
export interface Branch {
  name: string;
  sha: string;
  protected: boolean;
}
export interface MergeResult {
  mergedSha: string;
  /** The head commit that was merged. */
  headSha: string;
  /** `into` was moved to `head` (no merge commit). */
  fastForward: boolean;
  /** The merged tree differs from `head`'s: `into` had commits of its own (the workspace has to load it). */
  treeChanged: boolean;
}
export type Author = { name: string; email: string };
export type Repo = { owner: string; name: string };
export type CommitInput = {
  branch: string; baseSha: string; subdir: string; files: [string, Uint8Array][]; message: string; author: Author; mergeParent?: string; create?: boolean;
};

/**
 * What Cresslet needs from a source control host, as one user. GitHub's is below; another provider is another
 * implementation (and a GIT_PROVIDERS entry).
 */
export interface SourceControlProvider {
  listRepos(): Promise<RepoInfo[]>;
  createRepo(input: { owner?: string; name: string; private: boolean; description?: string }): Promise<RepoInfo>;
  repo(r: Repo): Promise<RepoInfo>;
  /** A branch's head commit, or null if there's no such branch. */
  branchHead(r: Repo, branch: string): Promise<string | null>;
  listBranches(r: Repo): Promise<Branch[]>;
  createBranch(r: Repo, branch: string, sha: string): Promise<void>;
  deleteBranch(r: Repo, branch: string): Promise<boolean>;
  /** The project's files at `sha` (under `subdir`), as the studio and deploys see source (sanitized). */
  readTree(r: Repo, sha: string, subdir: string): Promise<DeployFile[]>;
  /** One commit on `branch` (whose head must still be `baseSha`) making `subdir` hold exactly `files`. */
  /** `mergeParent`: a second parent (a merge of that commit, its conflicts resolved in `files`). */
  /**
   * `create`: `branch` is a new branch, made pointing at the commit (none when nothing changed). Taken: 409
   * `branch_exists` with the commit as `extra.sha`, for createBranch under another name.
   */
  commitTree(r: Repo, input: CommitInput): Promise<{ sha: string; changed: boolean }>;
  /** `expect`: the head commit the caller built from; if the branch moved past it, 409 and nothing merged. */
  merge(r: Repo, input: { into: string; head: string; message: string; expect?: string }): Promise<MergeResult>;
  /** Pull requests (stacked changes, server/stack.ts): by number, the open one from a branch, new, changed. */
  getPull(r: Repo, number: number): Promise<Pull>;
  findPull(r: Repo, head: string): Promise<Pull | null>;
  createPull(r: Repo, input: { head: string; base: string; title: string; body: string }): Promise<Pull>;
  updatePull(r: Repo, number: number, input: { base?: string; title?: string; body?: string; state?: "open" | "closed" }): Promise<Pull>;
  /** Its review decision and its head's checks. */
  pullStatus(r: Repo, number: number): Promise<PullInfo>;
  /** A change undone on `top`, file by file, for the workspace (conflicts marked); see GitHub#revert. */
  revert(r: Repo, input: { change: string; parent: string; top: string; subdir: string; label: string }): Promise<{ conflicts: string[]; files: DeployFile[]; restore?: string[] }>;
  /** A comment on a pull request, as the user. */
  commentPull(r: Repo, number: number, body: string): Promise<void>;
  /**
   * Why `branch` takes no direct moves (branch protection, or a ruleset needing pull requests, checks…), or null.
   * Checked by Cresslet before moving the default branch: GitHub lets an admin through when protection isn't enforced
   * for admins.
   */
  branchProtection(r: Repo, branch: string): Promise<string | null>;
  /** Moves `branch` from `from` to `to`, a fast-forward (never forced). Moved meanwhile: 409 `conflict`. */
  moveBranch(r: Repo, branch: string, from: string, to: string): Promise<void>;
  /** Whether `sha` holds `of` (it's `of`, or `of` is one of its ancestors). */
  contains(r: Repo, sha: string, of: string): Promise<boolean>;
  /** The merge methods the repository allows for pull requests. */
  mergeMethods(r: Repo): Promise<{ merge: boolean; squash: boolean; rebase: boolean }>;
  /**
   * Merges a pull request through the host (its reviews, checks and rules applied), as a merge commit, only while
   * its head is `sha`. Resolves to the merge commit; refused: 409 `merge_refused` with the host's reason.
   */
  mergePull(r: Repo, number: number, input: { sha: string; title: string }): Promise<{ sha: string }>;
}
export interface Pull {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  base: string;
  head: string;
  /** Merged: its merge commit. */
  mergeSha?: string | null;
  /** Its head commit (merged: the one merged). */
  headSha?: string;
}

/** GitHub's REST API with one user's token. `unauthorized`: GitHub rejected the token (revoked meanwhile). */
export class GitHub implements SourceControlProvider {
  #api: string;
  #web: string;
  #token: string;
  #unauthorized: () => Promise<void>;
  limits: { files: number; bytes: number };

  constructor(o: { apiUrl: string; webUrl: string; token: string; unauthorized: () => Promise<void>; limits: { files: number; bytes: number } }) {
    this.#api = o.apiUrl;
    this.#web = o.webUrl;
    this.#token = o.token;
    this.#unauthorized = o.unauthorized;
    this.limits = o.limits;
  }

  /** The response as is (callers handle the statuses they expect); 401 and failures to reach GitHub throw. */
  async req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    let res: Response;
    try {
      res = await fetch(this.#api + path, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "user-agent": "cresslet",
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(502, "couldn't reach GitHub, try again", "github_error");
    }
    if (res.status === 401) {
      await this.#unauthorized();
      throw reauth();
    }
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  }

  /** 2xx or throws: 404 (missing, or no access: GitHub hides private repos), 403, else 502. */
  async ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.req<T & { message?: string }>(method, path, body);
    if (r.status >= 200 && r.status < 300) return r.body;
    throw ghError(r.status, r.body?.message);
  }

  #path = (r: Repo, rest = "") => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}${rest}`;
  #ref = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

  #info = (x: GhRepo): RepoInfo => ({
    id: String(x.id),
    owner: x.owner.login,
    name: x.name,
    fullName: x.full_name,
    private: x.private,
    defaultBranch: x.default_branch,
    url: x.html_url ?? `${this.#web}/${x.full_name}`,
    push: !!x.permissions?.push,
  });

  async listRepos() {
    const list = await this.ok<GhRepo[]>("GET", "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");
    return list.map(this.#info).filter((x) => x.push);
  }

  async createRepo(input: { owner?: string; name: string; private: boolean; description?: string }) {
    const path = input.owner ? `/orgs/${encodeURIComponent(input.owner)}/repos` : "/user/repos";
    // auto_init: the Git Data API can't write to a repository without a commit.
    const r = await this.req<GhRepo & { message?: string; errors?: { message?: string }[] }>("POST", path, {
      name: input.name, private: input.private, description: input.description, auto_init: true,
    });
    if (r.status === 422) {
      throw new HttpError(409, r.body?.errors?.[0]?.message ?? r.body?.message ?? "couldn't create that repository", "repo_exists");
    }
    if (r.status < 200 || r.status >= 300) throw ghError(r.status, r.body?.message);
    return this.#info(r.body);
  }

  async repo(r: Repo) {
    return this.#info(await this.ok<GhRepo>("GET", this.#path(r)));
  }

  /** The repository with this id, wherever it is now (renamed or transferred). */
  async repoById(id: string) {
    return this.#info(await this.ok<GhRepo>("GET", `/repositories/${encodeURIComponent(id)}`));
  }

  async branchHead(r: Repo, branch: string): Promise<string | null> {
    const res = await this.req<{ object?: { sha: string }; message?: string } | { object?: { sha: string } }[]>(
      "GET", this.#path(r, `/git/ref/heads/${this.#ref(branch)}`),
    );
    // 409: an empty repository. An array: no such branch, only refs under it (`feat` when there's `feat/x`).
    if (res.status === 404 || res.status === 409 || (res.status === 200 && Array.isArray(res.body))) return null;
    if (res.status !== 200 || Array.isArray(res.body)) throw ghError(res.status, (res.body as { message?: string })?.message);
    return res.body.object?.sha ?? null;
  }

  async listBranches(r: Repo) {
    const list = await this.ok<{ name: string; commit: { sha: string }; protected: boolean }[]>("GET", this.#path(r, "/branches?per_page=100"));
    return list.map((b) => ({ name: b.name, sha: b.commit.sha, protected: !!b.protected }));
  }

  async createBranch(r: Repo, branch: string, sha: string) {
    const res = await this.req<{ message?: string }>("POST", this.#path(r, "/git/refs"), { ref: `refs/heads/${branch}`, sha });
    // Taken: by a branch of that name, or one whose name is in the way (`feat/x` for `feat/x/1-y`, or the other way).
    if (res.status === 422 && (/already exists|cannot be created|conflict/i.test(res.body?.message ?? "") || await this.#inTheWay(r, branch))) {
      throw new HttpError(409, `branch ${branch} already exists`, "branch_exists");
    }
    if (res.status !== 201) throw ghError(res.status, res.body?.message);
  }

  /**
   * A branch of that name, of a folder of it (`feat/x` for `feat/x/1-y`), or under it (`feat/x/y` for `feat/x`)
   * exists: what a refused create meant.
   */
  async #inTheWay(r: Repo, branch: string) {
    const parts = branch.split("/");
    const names = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    const under = this.req<unknown>("GET", this.#path(r, `/git/matching-refs/heads/${this.#ref(branch)}/`))
      .then((x) => x.status === 200 && Array.isArray(x.body) && x.body.length > 0, () => false);
    return (await Promise.all([under, ...names.map((n) => this.branchHead(r, n).then(Boolean, () => false))])).some(Boolean);
  }

  /** True if it was deleted (false: it wasn't there). */
  async deleteBranch(r: Repo, branch: string): Promise<boolean> {
    const res = await this.req<{ message?: string }>("DELETE", this.#path(r, `/git/refs/heads/${this.#ref(branch)}`));
    if (res.status === 204) return true;
    if (res.status === 404 || res.status === 422) return false;
    throw ghError(res.status, res.body?.message);
  }

  /** The commit's whole tree, flat (no submodules followed). */
  async #tree(r: Repo, commitSha: string) {
    const commit = await this.ok<{ tree: { sha: string } }>("GET", this.#path(r, `/git/commits/${commitSha}`));
    const t = await this.ok<{ tree: GhEntry[]; truncated: boolean }>("GET", this.#path(r, `/git/trees/${commit.tree.sha}?recursive=1`));
    if (t.truncated) throw new HttpError(413, "the repository has too many files to sync", "too_large");
    return { treeSha: commit.tree.sha, entries: t.tree };
  }

  async #blob(r: Repo, sha: string): Promise<Uint8Array> {
    const b = await this.ok<{ content: string; encoding: string }>("GET", this.#path(r, `/git/blobs/${sha}`));
    return new Uint8Array(Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8"));
  }

  /** Every entry of a commit's tree that isn't a folder (files, symlinks, submodules), by path. */
  async #entries(r: Repo, sha: string) {
    return new Map((await this.#tree(r, sha)).entries.filter((e) => e.type !== "tree").map((e) => [e.path, e]));
  }

  /**
   * Merging `theirs` into `ours` (their merge base `base`), for what the studio doesn't hold (outside `subdir`,
   * never-source files, symlinks, dotenv files: see `studioHolds`): the tree entries to take from `theirs`, and the
   * paths both sides changed (which the studio can't resolve).
   */
  #mergeOutside(subdir: string, base: Map<string, GhEntry>, ours: Map<string, GhEntry>, theirs: Map<string, GhEntry>) {
    const same = (x?: GhEntry, y?: GhEntry) => x?.sha === y?.sha && x?.mode === y?.mode;
    const take: { path: string; mode: string; type: string; sha: string | null }[] = [], both: string[] = [];
    // Held only if it's a file the studio holds on every side that has it (a regular file turned symlink isn't).
    const outside = new Set<string>();
    for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
      const [b, o, t] = [base.get(path), ours.get(path), theirs.get(path)];
      if ([b, o, t].every((e) => !e || studioHolds(path, e, subdir))) continue;
      outside.add(path);
      if (same(o, t) || same(t, b)) continue;
      if (same(o, b)) take.push(t ? { path, mode: t.mode, type: t.type, sha: t.sha } : { path, mode: o!.mode, type: o!.type, sha: null });
      else both.push(path);
    }
    return { take, both: both.sort(), outside };
  }

  async readTree(r: Repo, sha: string, subdir: string): Promise<DeployFile[]> {
    const { entries } = await this.#tree(r, sha);
    const files = sourceEntries(entries, subdir).filter((e) => !NOT_SOURCE.test(e.rel));
    if (files.length > this.limits.files) throw new HttpError(413, `the repository has more than ${this.limits.files} files`, "too_large");
    if (files.reduce((n, e) => n + (e.size ?? 0), 0) > this.limits.bytes) {
      throw new HttpError(413, `the repository's files exceed ${this.limits.bytes} bytes`, "too_large");
    }
    const out = await pool(files, 8, async (e): Promise<DeployFile> => {
      let data = await this.#blob(r, e.sha);
      if (DOTENV.test(e.rel)) data = publicDotenv(data);
      try {
        return { path: e.rel, data: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data), encoding: "utf8" };
      } catch {
        return { path: e.rel, data: Buffer.from(data).toString("base64"), encoding: "base64" };
      }
    });
    return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }

  async commitTree(r: Repo, input: CommitInput) {
    const { treeSha, entries } = await this.#tree(r, input.baseSha);
    const prefix = input.subdir ? input.subdir + "/" : "";
    const base = new Map(entries.filter((e) => e.type === "blob").map((e) => [e.path, e]));
    // A merge (`mergeParent`): the studio's files are the resolution of what it holds; everything else (outside
    // subdir, dotenv files…) is merged here, and both sides changing one of those stops it.
    let outside: { path: string; mode: string; type: string; sha: string | null }[] = [];
    let notHeld = new Set<string>();
    if (input.mergeParent) {
      const cmp = await this.ok<{ merge_base_commit: { sha: string } }>("GET", this.#path(r, `/compare/${input.mergeParent}...${input.baseSha}`));
      const [b, t] = await Promise.all([this.#entries(r, cmp.merge_base_commit.sha), this.#entries(r, input.mergeParent)]);
      const ours = new Map(entries.filter((e) => e.type !== "tree").map((e) => [e.path, e]));
      const m = this.#mergeOutside(input.subdir, b, ours, t);
      if (m.both.length) throw unresolvable(m.both);
      outside = m.take;
      notHeld = m.outside;
      // Dotenv files are merged here: the studio's copy must be the merged one's public entries (an edit made while
      // resolving would be lost otherwise: commit it afterwards).
      const taken = new Map(m.take.map((x) => [x.path, x]));
      const result = (path: string) => (taken.has(path) ? taken.get(path)! : ours.get(path));
      const sent = new Map(input.files.filter(([p]) => DOTENV.test(prefix + p)).map(([p, d]) => [prefix + p, d]));
      const changed = (p: string) => Object.assign(new HttpError(409, `${p.slice(prefix.length)} was changed while merging: commit the merge first, then that change`, "merge_dotenv_changed"), { extra: { paths: [p.slice(prefix.length)] } });
      for (const [path, d] of sent) {
        const e = result(path);
        // Gone upstream (or not a file the workspace holds), kept here with only private lines: not committed.
        if (!e?.sha || !workspaceEnv(e, path, prefix)) {
          if (new TextDecoder().decode(publicDotenv(d)).trim()) throw changed(path);
          continue;
        }
        if (!Buffer.from(publicDotenv(await this.#blob(r, e.sha))).equals(Buffer.from(d))) throw changed(path);
      }
      // So are the other files merged here that the workspace was given (a symlink on one side, a file on the other):
      // as they were.
      const given = (path: string) => { const e = result(path); return !DOTENV.test(path) && notHeld.has(path) && !!e?.sha && workspaceFile(e, path, prefix); };
      for (const [p, d] of input.files) {
        const path = prefix + p;
        if (given(path) && !Buffer.from(await this.#blob(r, result(path)!.sha!)).equals(Buffer.from(d))) throw changed(path);
      }
      const names = new Set(input.files.map(([p]) => prefix + p));
      // …and none deleted here meanwhile.
      for (const path of new Set([...taken.keys(), ...ours.keys()])) {
        const e = result(path);
        if (e?.sha && workspaceEnv(e, path, prefix) && !sent.has(path)) throw changed(path);
        if (given(path) && !names.has(path)) throw changed(path);
      }
    }
    const held = (path: string) => !input.mergeParent || (!DOTENV.test(path) && !notHeld.has(path));
    const want = new Map(input.files.map(([p, d]) => [prefix + p, d] as const).filter(([p]) => held(p)));
    const changes: { path: string; mode: string; data: Uint8Array }[] = [];
    for (const [path, data] of want) {
      const b = base.get(path);
      if (b?.sha === blobSha(data) && b.mode !== "120000") continue;
      // A dotenv file the studio only ever saw cut to its public entries: unchanged if those are, so the
      // repository's own copy (whatever else it holds) stays.
      let out = data;
      if (b && b.mode !== "120000" && DOTENV.test(path)) {
        const theirs = await this.#blob(r, b.sha);
        if (Buffer.from(publicDotenv(theirs)).equals(Buffer.from(data))) continue;
        // Changed: its public entries replaced, its private lines (never sent to the studio) kept.
        const dec = new TextDecoder();
        const merged = mergeDotenvText(dec.decode(theirs), dec.decode(data));
        if (merged === null) {
          const rel = path.slice(prefix.length);
          throw Object.assign(new HttpError(409, `${rel} can't be updated without losing the lines of it the studio doesn't show: edit it on GitHub`, "dotenv_unmergeable"), { extra: { paths: [rel] } });
        }
        out = new TextEncoder().encode(merged);
      }
      changes.push({ path, mode: b && b.mode !== "120000" ? b.mode : "100644", data: out });
    }
    // Under subdir, files the studio was never sent stay: never-source ones, symlinks, names it can't hold.
    const gone = [...base.values()].filter((e) => e.path.startsWith(prefix) && !want.has(e.path) && sourceEntries([e], input.subdir).length &&
      !NOT_SOURCE.test(e.path.slice(prefix.length)) && held(e.path)).map((e) => e.path);
    if (!changes.length && !gone.length && !input.mergeParent) return { sha: input.baseSha, changed: false };
    const blobs = await pool(changes, 8, (ch) =>
      this.ok<{ sha: string }>("POST", this.#path(r, "/git/blobs"), { content: Buffer.from(ch.data).toString("base64"), encoding: "base64" }));
    const tree = !changes.length && !gone.length && !outside.length ? { sha: treeSha } : await this.ok<{ sha: string }>("POST", this.#path(r, "/git/trees"), {
      base_tree: treeSha,
      tree: [
        ...changes.map((ch, i) => ({ path: ch.path, mode: ch.mode, type: "blob", sha: blobs[i].sha })),
        ...gone.map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
        ...outside,
      ],
    });
    const who = { name: input.author.name, email: input.author.email };
    const commit = await this.ok<{ sha: string }>("POST", this.#path(r, "/git/commits"), {
      message: input.message, tree: tree.sha, parents: input.mergeParent ? [input.baseSha, input.mergeParent] : [input.baseSha],
      author: who, committer: who,
    });
    if (input.create) {
      try {
        await this.createBranch(r, input.branch, commit.sha);
      } catch (e) {
        if (e instanceof HttpError && e.code === "branch_exists") throw Object.assign(e, { extra: { sha: commit.sha } });
        throw e;
      }
      return { sha: commit.sha, changed: true };
    }
    // Never forced: if the branch moved since baseSha, this fails and nothing changed.
    const res = await this.req<{ message?: string }>("PATCH", this.#path(r, `/git/refs/heads/${this.#ref(input.branch)}`), { sha: commit.sha, force: false });
    if (res.status !== 200) {
      // Moved meanwhile (GitHub says so as a 422 "not a fast forward", or a 409): nothing changed; say where it is now.
      const now = await this.branchHead(r, input.branch).catch(() => null);
      if (!isProtected(res.body?.message) && ((now && now !== input.baseSha) || notFastForward(res.status, res.body?.message))) {
        throw Object.assign(conflict(`${input.branch} moved on GitHub meanwhile: pull first`), { extra: now ? { headSha: now } : {} });
      }
      throw refError(res.status, res.body?.message, input.branch);
    }
    return { sha: commit.sha, changed: true };
  }

  async merge(r: Repo, input: { into: string; head: string; message: string; expect?: string }): Promise<MergeResult> {
    const [intoSha, headSha] = await Promise.all([this.branchHead(r, input.into), this.branchHead(r, input.head)]);
    if (!intoSha) throw new HttpError(404, `no branch ${input.into} on GitHub`, "branch_not_found");
    if (!headSha) throw new HttpError(404, `no branch ${input.head} on GitHub`, "branch_not_found");
    if (input.expect && headSha !== input.expect) {
      throw Object.assign(conflict(`${input.head} moved on GitHub since it was synced: pull it first`), { extra: { headSha } });
    }
    if (intoSha === headSha) return { mergedSha: intoSha, headSha, fastForward: true, treeChanged: false };
    const cmp = await this.ok<{ status: string }>("GET", this.#path(r, `/compare/${intoSha}...${headSha}`));
    if (cmp.status === "identical") return { mergedSha: intoSha, headSha, fastForward: true, treeChanged: false };
    // Already in: nothing to merge, but `into` has more than head.
    if (cmp.status === "behind") return { mergedSha: intoSha, headSha, fastForward: false, treeChanged: true };
    if (cmp.status === "ahead") {
      await this.moveBranch(r, input.into, intoSha, headSha);
      return { mergedSha: headSha, headSha, fastForward: true, treeChanged: false };
    }
    // Read before merging: once it's merged, nothing that can fail stands between the merge and its result.
    const head = await this.ok<{ tree: { sha: string } }>("GET", this.#path(r, `/git/commits/${headSha}`));
    const res = await this.req<{ sha?: string; commit?: { tree: { sha: string } }; message?: string }>(
      "POST", this.#path(r, "/merges"), { base: input.into, head: headSha, commit_message: input.message },
    );
    if (res.status === 201 && res.body?.sha) {
      return { mergedSha: res.body.sha, headSha, fastForward: false, treeChanged: res.body.commit?.tree.sha !== head.tree.sha };
    }
    if (res.status === 204) {
      // Merged meanwhile (by someone else): where `into` is now.
      const now = await this.branchHead(r, input.into) ?? intoSha;
      return { mergedSha: now, headSha, fastForward: false, treeChanged: true };
    }
    if (isProtected(res.body?.message)) throw protectedError(input.into);
    if (res.status === 409) {
      throw Object.assign(new HttpError(409, `${input.head} doesn't merge cleanly into ${input.into}`, "merge_conflict"), {
        extra: { paths: await this.#conflicts(r, intoSha, headSha).catch(() => []) },
      });
    }
    throw refError(res.status, res.body?.message, input.into);
  }

  /** Paths both sides changed since they split: where the conflicts are (GitHub doesn't say). */
  async #conflicts(r: Repo, intoSha: string, headSha: string): Promise<string[]> {
    const ours = await this.ok<{ merge_base_commit: { sha: string }; files?: { filename: string }[] }>(
      "GET", this.#path(r, `/compare/${intoSha}...${headSha}`),
    );
    const theirs = await this.ok<{ files?: { filename: string }[] }>("GET", this.#path(r, `/compare/${ours.merge_base_commit.sha}...${intoSha}`));
    const changed = new Set((theirs.files ?? []).map((f) => f.filename));
    return (ours.files ?? []).map((f) => f.filename).filter((f) => changed.has(f)).sort();
  }

  /**
   * `head` merged with `into` (where it would go), for resolving their conflicts on `head`: every file of the
   * result under `subdir`, as the workspace holds them. A file both changed since they split is a conflict: text
   * gets both versions between `<<<<<<<` / `=======` / `>>>>>>>` lines; binary ones, and anything the studio doesn't
   * hold, can't be resolved here (409 merge_unresolvable). Committed with `into`'s
   * head as a second parent, `head` then merges into `into` as a fast-forward.
   */
  async conflicts(r: Repo, input: { into: string; head: string; subdir: string }) {
    const [intoSha, headSha] = await Promise.all([this.branchHead(r, input.into), this.branchHead(r, input.head)]);
    if (!intoSha || !headSha) throw new HttpError(404, `no branch ${!intoSha ? input.into : input.head} on GitHub`, "branch_not_found");
    const cmp = await this.ok<{ merge_base_commit: { sha: string } }>("GET", this.#path(r, `/compare/${intoSha}...${headSha}`));
    const full = await Promise.all([cmp.merge_base_commit.sha, headSha, intoSha].map((sha) => this.#entries(r, sha))) as [Entries, Entries, Entries];
    // What the studio doesn't hold must merge by itself (else: a pull request).
    const outside = this.#mergeOutside(input.subdir, full[0], full[1], full[2]);
    if (outside.both.length) throw unresolvable(outside.both);
    return { intoSha, headSha, ...await this.#mergeHeld(r, full, input.subdir, outside, [input.head, input.into], unresolvable) };
  }

  /**
   * Change `change` (cut from `parent`) undone on `top`, for the workspace: a three-way merge of `top` with `parent`,
   * `change` as the base. Every file of the result under `subdir`, as the workspace holds them; one later changes also
   * touched where the change did is a conflict, both versions between markers (`now` / `undo <label>`). Binary files
   * both sides changed, and anything the change touched that the studio doesn't hold (outside `subdir`, dotenv files),
   * can't be undone here (409 merge_unresolvable). A change with a merge in it (the default branch merged in, a push
   * pulled in) isn't undone either: that would undo the merged work too (409 undo_merge).
   */
  async revert(r: Repo, input: { change: string; parent: string; top: string; subdir: string; label: string }) {
    const cmp = await this.ok<{ status: string; total_commits?: number; commits?: { parents: unknown[] }[] }>("GET", this.#path(r, `/compare/${input.parent}...${input.change}`));
    const commits = cmp.commits ?? [];
    if (cmp.status !== "ahead" || (cmp.total_commits ?? commits.length) > commits.length || commits.some((c) => c.parents.length !== 1)) {
      throw new HttpError(409, `${input.label} has a merge in it (from the default branch, or pulled in from GitHub): undoing it would undo that too, so it isn't done in the studio`, "undo_merge");
    }
    const full = await Promise.all([input.change, input.top, input.parent].map((sha) => this.#entries(r, sha))) as [Entries, Entries, Entries];
    const outside = this.#mergeOutside(input.subdir, full[0], full[1], full[2]);
    // (Taking those from the parent would need a commit the workspace can't make, but for a dotenv file's public entries.)
    // The studio's commit can't set modes: an executable the change deleted or made plain (still so at the top), or a
    // file it made executable (still so), can't be put back.
    const exec = [...full[2].values()].filter((e) => e.mode === "100755" && full[0].get(e.path)?.mode !== "100755" && full[1].get(e.path)?.mode !== "100755")
      .concat([...full[0].values()].filter((e) => e.mode === "100755" && full[2].get(e.path)?.mode === "100644" && full[1].get(e.path)?.mode === "100755"));
    // …nor keep a mode a later change gave a file the undo puts back or deletes.
    const plain = (m?: string) => m === "100644" || m === "100755";
    const moded = [...full[0].values()].filter((e) => {
      const [t, p] = [full[1].get(e.path), full[2].get(e.path)];
      // (Content only put back: the commit keeps the top's mode, as a merge would.)
      return !!t && plain(e.mode) && plain(t.mode) && t.mode !== e.mode && (!p || p.mode !== e.mode);
    });
    // A dotenv file only the change touched, on both sides: put back through the workspace's commit (its public
    // entries replaced, its private lines kept) when that gives the parent's file exactly.
    const prefix = input.subdir ? input.subdir + "/" : "";
    const dec = new TextDecoder();
    const envBack = async (x: Outside["take"][number]) => {
      const [t, p] = [full[1].get(x.path), full[2].get(x.path)];
      if (!DOTENV.test(x.path) || !x.sha || !t || !p || t.mode !== p.mode || !workspaceEnv(t, x.path, prefix) || !workspaceEnv(p, x.path, prefix)) return false;
      // By bytes: what the commit would write against the parent's file (text that isn't UTF-8 wouldn't survive it).
      const [want, now] = await Promise.all([p.sha, t.sha].map((sha) => this.#blob(r, sha)));
      const pub = publicDotenv(want);
      // (Its public entries as they are: the commit leaves the file alone.)
      if (Buffer.from(pub).equals(Buffer.from(publicDotenv(now)))) return Buffer.from(now).equals(Buffer.from(want));
      const merged = mergeDotenvText(dec.decode(now), dec.decode(pub));
      return merged !== null && Buffer.from(new TextEncoder().encode(merged)).equals(Buffer.from(want));
    };
    const back = new Set((await Promise.all(outside.take.map(async (x) => (await envBack(x)) ? x.path : null))).filter((x) => x !== null));
    const refused = [...new Set([...outside.both, ...outside.take.map((x) => x.path).filter((x) => !back.has(x)), ...exec.map((e) => e.path), ...moded.map((e) => e.path)])].sort();
    const refuse = (paths: string[]) => Object.assign(
      new HttpError(409, `${paths.join(", ")} can't be undone in the studio (outside what it holds, binary, an executable, or a file where a folder is now): undo it on GitHub`, "merge_unresolvable"),
      { extra: { paths } },
    );
    if (refused.length) throw refuse(refused);
    // `restore`: the dotenv files it puts back (their public entries), for the studio to hold its commit to.
    return { ...await this.#mergeHeld(r, full, input.subdir, outside, ["now", `undo ${input.label}`], refuse), restore: [...back].map((p) => p.slice(prefix.length)).sort() };
  }

  /** The three-way merge of what the studio holds (base, ours, theirs), conflicts marked with `labels`; `refuse`: what can't be held. */
  async #mergeHeld(r: Repo, full: [Entries, Entries, Entries], subdir: string, outside: Outside, labels: [string, string], refuse: (paths: string[]) => Error) {
    const input = { subdir, head: labels[0], into: labels[1] };
    const prefix = input.subdir ? input.subdir + "/" : "";
    const [base, ours, theirs] = full.map((m) => new Map([...m.values()].filter((e) => !outside.outside.has(e.path) && studioHolds(e.path, e, input.subdir)).map((e) => [e.path.slice(prefix.length), { ...e, rel: e.path.slice(prefix.length) }])));
    const out = new Map<string, Uint8Array>(), conflicts: string[] = [];
    const read = (e: GhEntry) => this.#blob(r, e.sha).then((d) => (DOTENV.test(e.path) ? publicDotenv(d) : d));
    const text = (d: Uint8Array) => {
      if (d.includes(0)) return null; // binary, even if it decodes
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(d);
      } catch {
        return null;
      }
    };
    const paths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])];
    // Dotenv files (merged by mergeOutside): the result's, read below for their public entries.
    const taken = new Map(outside.take.map((x) => [x.path, x]));
    // …and ours where the merge keeps it though another side has something the studio doesn't hold (a symlink turned file).
    for (const [path, e] of full[1]) if (!taken.has(path) && path.startsWith(prefix) && (DOTENV.test(path) || outside.outside.has(path))) taken.set(path, { path, mode: e.mode, type: e.type, sha: e.sha });
    // …and files the merge takes from the default branch that the workspace holds (a symlink there turned into a file).
    const envs = [...taken.values()].filter((x) => !!x.sha && workspaceFile(x, x.path, prefix));
    if (paths.length + envs.length > this.limits.files) throw new HttpError(413, `the repository has more than ${this.limits.files} files`, "too_large");
    const sizeOf = (sha: string) => [...full[1].values(), ...full[2].values()].find((e) => e.sha === sha)?.size ?? 0;
    // What's read: one side of a file only one side changed, both of a conflict, and the dotenv files.
    const size = paths.reduce((n, p) => {
      const [b, o, t] = [base.get(p), ours.get(p), theirs.get(p)];
      if (o?.sha === t?.sha || t?.sha === b?.sha) return n + (o?.size ?? 0);
      if (o?.sha === b?.sha) return n + (t?.size ?? 0);
      return n + (o?.size ?? 0) + (t?.size ?? 0);
    }, envs.reduce((n, x) => n + sizeOf(x.sha!), 0));
    if (size > this.limits.bytes) throw new HttpError(413, `the merge's files exceed ${this.limits.bytes} bytes`, "too_large");
    // Binary files both sides changed: no markers to resolve them with.
    const binary: string[] = [];
    await pool(paths, 8, async (p) => {
      const [b, o, t] = [base.get(p)?.sha, ours.get(p)?.sha, theirs.get(p)?.sha];
      const pick = o === t || t === b ? ours.get(p) : o === b ? theirs.get(p) : undefined;
      if (o === t || t === b || o === b) {
        if (pick) out.set(p, await read(pick));
        return;
      }
      conflicts.push(p);
      const [od, td] = await Promise.all([ours.get(p) ? read(ours.get(p)!) : null, theirs.get(p) ? read(theirs.get(p)!) : null]);
      const [ot, tt] = [od ? text(od) : "", td ? text(td) : ""];
      if (ot === null || tt === null) {
        binary.push(p);
        return;
      }
      const nl = (x: string) => (x && !x.endsWith("\n") ? x + "\n" : x);
      out.set(p, new TextEncoder().encode(`<<<<<<< ${input.head}\n${nl(ot)}=======\n${nl(tt)}>>>>>>> ${input.into}\n`));
    });
    if (binary.length) throw refuse(binary.map((p) => prefix + p));
    // Dotenv files (merged outside the studio's part): the result's public entries, as the workspace holds them.
    for (const x of envs) {
      const d = await this.#blob(r, x.sha!);
      out.set(x.path.slice(prefix.length), DOTENV.test(x.path) ? publicDotenv(d) : d);
    }
    // A file where the result has a folder (a file deleted, then one added under its name): can't be held.
    const folders = new Set([...out.keys()].flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
    const clash = [...out.keys()].filter((p) => folders.has(p)).sort();
    if (clash.length) throw refuse(clash.map((p) => prefix + p));
    const files: DeployFile[] = [...out].sort(([x], [y]) => (x < y ? -1 : 1)).map(([path, d]) => {
      const t = text(d);
      return t === null ? { path, data: Buffer.from(d).toString("base64"), encoding: "base64" } : { path, data: t, encoding: "utf8" };
    });
    return { conflicts: conflicts.sort(), files };
  }

  #pull = (p: GhPull): Pull => ({
    number: p.number, url: p.html_url, state: p.state === "closed" ? "closed" : "open", merged: !!p.merged_at || !!p.merged,
    base: p.base?.ref ?? "", head: p.head.ref ?? "", mergeSha: p.merge_commit_sha ?? null, headSha: p.head.sha,
  });
  /** A refused pull request call: GitHub's own reason (422), else as any other call. */
  #pullError(res: { status: number; body: { message?: string; errors?: { message?: string }[] } | null }) {
    if (res.status === 422) return new HttpError(422, res.body?.errors?.[0]?.message ?? res.body?.message ?? "GitHub refused that pull request", "pull_invalid");
    return ghError(res.status, res.body?.message);
  }

  async getPull(r: Repo, number: number) {
    return this.#pull(await this.ok<GhPull>("GET", this.#path(r, `/pulls/${number}`)));
  }

  async findPull(r: Repo, head: string) {
    const list = await this.ok<GhPull[]>("GET", this.#path(r, `/pulls?state=open&head=${encodeURIComponent(`${r.owner}:${head}`)}`));
    return list[0] ? this.#pull(list[0]) : null;
  }

  async createPull(r: Repo, input: { head: string; base: string; title: string; body: string }) {
    const res = await this.req<GhPull & { message?: string; errors?: { message?: string }[] }>("POST", this.#path(r, "/pulls"), input);
    if (res.status !== 201) throw this.#pullError(res);
    return this.#pull(res.body);
  }

  async updatePull(r: Repo, number: number, input: { base?: string; title?: string; body?: string; state?: "open" | "closed" }) {
    const res = await this.req<GhPull & { message?: string; errors?: { message?: string }[] }>("PATCH", this.#path(r, `/pulls/${number}`), input);
    if (res.status !== 200) throw this.#pullError(res);
    return this.#pull(res.body);
  }

  async branchProtection(r: Repo, branch: string): Promise<string | null> {
    const [b, rules] = await Promise.all([
      this.ok<{ protected?: boolean }>("GET", this.#path(r, `/branches/${this.#ref(branch)}`)),
      // Rulesets (repository or organization): those that stand between a push and the branch. Not read: refused.
      this.req<{ type: string }[]>("GET", this.#path(r, `/rules/branches/${this.#ref(branch)}`)),
    ]);
    if (rules.status !== 200 || !Array.isArray(rules.body)) return `${branch}'s rules on GitHub couldn't be read`;
    const blocking = rules.body.map((x) => x.type).filter((t) => ["update", "pull_request", "required_status_checks", "required_deployments", "merge_queue", "required_signatures"].includes(t));
    if (blocking.length) return `${branch} has rules on GitHub (${[...new Set(blocking)].join(", ")})`;
    if (!b.protected) return null;
    // Classic protection: only what stands between a fast-forward and the branch (not force pushes or deletion).
    const p = await this.req<{
      required_pull_request_reviews?: unknown; required_status_checks?: unknown; restrictions?: unknown; required_signatures?: { enabled?: boolean };
      lock_branch?: { enabled?: boolean };
    }>("GET", this.#path(r, `/branches/${this.#ref(branch)}/protection`));
    // Not readable (only admins can read it; and some users may bypass it): never moved on a guess.
    if (p.status !== 200) return `${branch} is protected on GitHub`;
    const needs = [
      p.body.required_pull_request_reviews && "reviews", p.body.required_status_checks && "status checks", p.body.restrictions && "push restrictions",
      p.body.required_signatures?.enabled && "signed commits", p.body.lock_branch?.enabled && "locked",
    ].filter(Boolean);
    return needs.length ? `${branch} is protected on GitHub (${needs.join(", ")})` : null;
  }

  async moveBranch(r: Repo, branch: string, from: string, to: string) {
    const res = await this.req<{ message?: string }>("PATCH", this.#path(r, `/git/refs/heads/${this.#ref(branch)}`), { sha: to, force: false });
    if (res.status === 200) return;
    const now = await this.branchHead(r, branch).catch(() => null);
    if (!isProtected(res.body?.message) && ((now && now !== from) || notFastForward(res.status, res.body?.message))) {
      throw conflict(`${branch} moved on GitHub meanwhile: try again`);
    }
    throw refError(res.status, res.body?.message, branch);
  }

  async commentPull(r: Repo, number: number, body: string) {
    await this.ok("POST", this.#path(r, `/issues/${number}/comments`), { body });
  }

  async contains(r: Repo, sha: string, of: string) {
    if (sha === of) return true;
    const cmp = await this.ok<{ status: string }>("GET", this.#path(r, `/compare/${of}...${sha}`));
    return cmp.status === "ahead" || cmp.status === "identical";
  }

  async mergeMethods(r: Repo) {
    // (Not said, as for a user who can't push: allowed, and GitHub refuses at the merge if not.)
    const g = await this.ok<{ allow_merge_commit?: boolean; allow_squash_merge?: boolean; allow_rebase_merge?: boolean }>("GET", this.#path(r));
    return { merge: g.allow_merge_commit !== false, squash: g.allow_squash_merge !== false, rebase: g.allow_rebase_merge !== false };
  }

  async mergePull(r: Repo, number: number, input: { sha: string; title: string }) {
    const res = await this.req<{ sha?: string; message?: string }>("PUT", this.#path(r, `/pulls/${number}/merge`), {
      sha: input.sha, merge_method: "merge", commit_title: input.title,
    });
    if (res.status === 200 && res.body?.sha) return { sha: res.body.sha };
    // Not mergeable (reviews, checks, rules, conflicts), or its head moved: GitHub's reason.
    if (res.status === 405 || res.status === 409 || res.status === 422) {
      throw new HttpError(409, `GitHub didn't merge pull request #${number}: ${res.body?.message ?? "it isn't mergeable"}`, "merge_refused");
    }
    throw ghError(res.status, res.body?.message);
  }

  async pullStatus(r: Repo, number: number) {
    return this.#pullInfo(r, await this.ok<GhPull>("GET", this.#path(r, `/pulls/${number}`)));
  }

  /** The open pull request from `head` into `base`, if any. */
  async pull(r: Repo, head: string, base: string): Promise<PullInfo | null> {
    const list = await this.ok<GhPull[]>("GET", this.#path(r, `/pulls?state=open&head=${encodeURIComponent(`${r.owner}:${head}`)}&base=${encodeURIComponent(base)}`));
    return list[0] ? this.#pullInfo(r, list[0]) : null;
  }

  async openPull(r: Repo, input: { head: string; base: string; title: string; body: string }): Promise<{ pull: PullInfo; created: boolean }> {
    const existing = await this.pull(r, input.head, input.base);
    if (existing) return { pull: existing, created: false };
    const res = await this.req<GhPull & { message?: string; errors?: { message?: string }[] }>("POST", this.#path(r, "/pulls"), input);
    if (res.status === 422) throw new HttpError(422, res.body?.errors?.[0]?.message ?? res.body?.message ?? "GitHub wouldn't open that pull request", "pull_invalid");
    if (res.status !== 201) throw ghError(res.status, res.body?.message);
    return { pull: await this.#pullInfo(r, res.body), created: true };
  }

  /** A pull request with its review decision (latest review per reviewer) and its head's checks. */
  async #pullInfo(r: Repo, p: GhPull): Promise<PullInfo> {
    const [reviews, checks, status] = await Promise.all([
      this.ok<{ user: { login: string } | null; state: string }[]>("GET", this.#path(r, `/pulls/${p.number}/reviews?per_page=100`)).catch(() => []),
      // Needs the GitHub App's Checks: read permission; without it, unknown rather than "none".
      this.ok<{ check_runs: { status: string; conclusion: string | null }[] }>("GET", this.#path(r, `/commits/${p.head.sha}/check-runs?per_page=100`)).catch(() => null),
      // Commit statuses (the older kind of check, as some CI still reports).
      this.ok<{ statuses?: { state: string }[] }>("GET", this.#path(r, `/commits/${p.head.sha}/status`)).catch(() => null),
    ]);
    const latest = new Map<string, string>();
    for (const x of reviews) if (x.user && x.state !== "COMMENTED") latest.set(x.user.login, x.state);
    const states = [...latest.values()];
    // (A commit status as a check run: pending, or completed with its outcome. Either kind readable: known.)
    const runs = [...checks?.check_runs ?? [], ...(status?.statuses ?? []).map((x) => (x.state === "pending" ? { status: "queued", conclusion: null } : { status: "completed", conclusion: x.state }))];
    // Seen failing or running on either: so. Else none or all passing only when both could be read (one hidden from
    // this app could hold a required check).
    const known = !!checks && !!status;
    const seen = runs.some((x) => x.status !== "completed") ? "pending" as const
      : runs.some((x) => x.status === "completed" && !["success", "neutral", "skipped"].includes(x.conclusion ?? "")) ? "failure" as const : null;
    return {
      number: p.number, url: p.html_url, title: p.title, draft: !!p.draft, headSha: p.head.sha,
      review: states.includes("CHANGES_REQUESTED") ? "changes_requested" : states.includes("APPROVED") ? "approved" : "pending",
      checks: seen ?? (!known ? "unknown" : !runs.length ? "none" : "success"),
      base: p.base?.ref ?? "",
      mergeable: (["clean", "unstable", "has_hooks", "blocked", "behind", "dirty", "draft"] as const).find((x) => x === p.mergeable_state) ?? "unknown",
    };
  }

  /** A first commit in an empty repository (the Git Data API needs one), on its default branch. */
  async initialize(r: Repo, branch: string, author: Author): Promise<string> {
    const res = await this.req<{ commit?: { sha: string }; message?: string }>("PUT", this.#path(r, "/contents/.gitkeep"), {
      message: "Initialize repository", content: "", branch, author, committer: author,
    });
    if (res.status !== 201 || !res.body?.commit) throw ghError(res.status, res.body?.message);
    return res.body.commit.sha;
  }
}

type GhRepo = {
  id: number; name: string; full_name: string; private: boolean; default_branch: string; html_url?: string;
  owner: { login: string }; permissions?: { push?: boolean };
};
type GhEntry = { path: string; mode: string; type: string; sha: string; size?: number };
type Entries = Map<string, GhEntry>;
/** What a merge does with what the studio doesn't hold (GitHub#mergeOutside). */
type Outside = { take: { path: string; mode: string; type: string; sha: string | null }[]; both: string[]; outside: Set<string> };
type GhPull = {
  number: number; html_url: string; title: string; draft?: boolean; head: { sha: string; ref?: string }; base?: { ref: string };
  state?: string; merged?: boolean; merged_at?: string | null; mergeable_state?: string; merge_commit_sha?: string | null;
};
export interface PullInfo {
  number: number;
  url: string;
  title: string;
  draft: boolean;
  headSha: string;
  review: "approved" | "changes_requested" | "pending";
  checks: "success" | "failure" | "pending" | "none" | "unknown";
  /** Its base branch. */
  base: string;
  /**
   * Whether GitHub would merge it now (its `mergeable_state`): `clean`/`unstable`/`has_hooks` yes; `blocked` (reviews,
   * required checks, rules), `behind` (must be up to date with its base), `dirty` (conflicts), `draft`, or `unknown`
   * (not worked out yet, or read from a list).
   */
  mergeable: "clean" | "unstable" | "has_hooks" | "blocked" | "behind" | "dirty" | "draft" | "unknown";
}

/** The tree's regular files under `subdir`, with their paths relative to it (names a deploy can't hold left out). */
function sourceEntries(entries: GhEntry[], subdir: string) {
  const prefix = subdir ? subdir + "/" : "";
  const out: (GhEntry & { rel: string })[] = [];
  for (const e of entries) {
    if (e.type !== "blob" || e.mode === "120000" || !e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    try {
      if (safePath(rel) === rel) out.push({ ...e, rel });
    } catch { /* not a path we can hold */ }
  }
  return out;
}

/** Git's object id for a file's contents (what GitHub's tree lists), so unchanged files aren't uploaded again. */
export const blobSha = (data: Uint8Array) =>
  createHash("sha1").update(`blob ${data.byteLength}\0`).update(data).digest("hex");

export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * A path the studio holds and resolves itself in a merge: a regular file under subdir it can hold, not never-source,
 * not a dotenv file (it only ever has their public entries).
 */
function studioHolds(path: string, e: GhEntry, subdir: string) {
  const prefix = subdir ? subdir + "/" : "";
  if (!path.startsWith(prefix) || DOTENV.test(path)) return false;
  return sourceEntries([{ ...e, path }], subdir).length > 0 && !NOT_SOURCE.test(path.slice(prefix.length));
}
/** A regular file under subdir the workspace can hold (not never-source, a valid path): what it's sent and sends back. */
function workspaceFile(e: { type: string; mode: string }, path: string, prefix: string) {
  const rel = path.slice(prefix.length);
  if (!path.startsWith(prefix) || NOT_SOURCE.test(rel) || e.type !== "blob" || e.mode === "120000") return false;
  try {
    return safePath(rel) === rel;
  } catch {
    return false;
  }
}
const workspaceEnv = (e: { type: string; mode: string }, path: string, prefix: string) => DOTENV.test(path) && workspaceFile(e, path, prefix);
const unresolvable = (paths: string[]) => Object.assign(
  new HttpError(409, `both sides changed ${paths.join(", ")}, which can't be resolved in the studio: merge it on GitHub (a pull request)`, "merge_unresolvable"),
  { extra: { paths } },
);
const reauth = () => new HttpError(401, "GitHub access expired or was revoked: connect GitHub again", "git_reauth_required");
const conflict = (message: string) => new HttpError(409, message, "conflict");
const notFastForward = (status: number, m?: string) => status === 422 && /fast.?forward/i.test(m ?? "");
/** GitHub refusing because of branch protection or a ruleset (said in several ways). */
const isProtected = (m?: string) => /protected|required status|review|rule violation/i.test(m ?? "");
const protectedError = (branch: string) =>
  new HttpError(422, `${branch} is protected on GitHub (it needs a pull request or checks): merge it there`, "branch_protected");
function ghError(status: number, message?: string) {
  if (status === 404) return new HttpError(404, "not found on GitHub (or you don't have access to it)", "git_not_found");
  if (status === 403) return new HttpError(403, `GitHub refused: ${message ?? "forbidden"}`, "git_forbidden");
  return new HttpError(502, `GitHub: ${message ?? `error ${status}`}`, "github_error");
}
function refError(status: number, message: string | undefined, branch: string) {
  if (isProtected(message)) return protectedError(branch);
  return ghError(status, message);
}

/** Who Cresslet asks for repository access, and how: a GitHub App, or (fallback) the login OAuth App with `repo`. */
export function githubSync(cfg: Config) {
  const app = cfg.git.githubApp;
  if (app) {
    return {
      kind: "app" as const, clientId: app.clientId, clientSecret: app.clientSecret, scope: null,
      webUrl: cfg.git.webUrl, apiUrl: cfg.git.apiUrl,
      installUrl: app.slug ? `${cfg.git.webUrl}/apps/${app.slug}/installations/new` : null,
      // Registered as the GitHub App's callback URL.
      callbackPath: "/v1/git/github/callback",
    };
  }
  if (cfg.git.oauthFallback && cfg.github) {
    const gh = cfg.github;
    return {
      kind: "oauth" as const, clientId: gh.clientId, clientSecret: gh.clientSecret, scope: "repo read:user user:email",
      webUrl: gh.webUrl, apiUrl: gh.apiUrl,
      installUrl: `${gh.webUrl}/settings/connections/applications/${gh.clientId}`,
      // An OAuth App has one callback URL: login's, which hands source control's states (gs_…) to this flow.
      callbackPath: "/v1/auth/github/callback",
    };
  }
  return null;
}

export function gitRoutes(
  app: Hono<Env>,
  { cfg, store, body, readBody, accountWide, authorize, getApp, deployBodyLimit }: {
    cfg: Config;
    store: Store;
    body: <T>(c: Context<Env>, maxBytes?: number) => Promise<T>;
    /** A request's raw body, refused (413) past `maxBytes` while it's read. */
    readBody: (req: Request, maxBytes: number) => Promise<Uint8Array>;
    accountWide: (c: Context<Env>, role: Role) => Account;
    authorize: (c: Context<Env>, a: App, role: Role, opts?: { owner?: boolean; account?: boolean }) => Promise<unknown>;
    getApp: (name: string) => Promise<App>;
    deployBodyLimit: number;
  },
) {
  const gh = githubSync(cfg);
  const provider: GitProvider = "github";
  const states = new Map<string, { accountId: string; returnTo: string; exp: number }>();
  const refreshing = new Map<string, Promise<GitConnection>>();

  /** `__Host-` over HTTPS: an app or page on a subdomain can't plant one (and with it, its own state). */
  const STATE_COOKIE = cfg.scheme === "https" ? "__Host-cresslet_git_state" : "cresslet_git_state";
  const notConfigured = () => new HttpError(404, "source control isn't set up on this server (docs/self-hosting.md#source-control)", "git_unavailable");

  /** Form POST to GitHub's OAuth endpoints. */
  async function oauth(params: Record<string, string>): Promise<Record<string, string>> {
    const res = await fetch(gh!.webUrl + "/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: gh!.clientId, client_secret: gh!.clientSecret, ...params }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as Record<string, string> | null;
    if (!res || (!res.ok && !j?.error) || !j) throw new HttpError(502, "couldn't reach GitHub, try again", "github_error");
    return j;
  }

  const tokenFields = (t: Record<string, string>, now = Date.now()) => ({
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    expires_at: Number(t.expires_in) > 0 ? now + Number(t.expires_in) * 1000 : null,
    scopes: t.scope ?? null,
  });

  /**
   * The account's connection with a usable access token: refreshed first when it's about to expire. One refresh
   * per account at a time (GitHub's refresh tokens are single-use): in this process, and across servers on
   * Postgres (an advisory lock, then the row read again in case another server refreshed it).
   */
  async function connection(accountId: string): Promise<GitConnection> {
    if (!gh) throw notConfigured();
    const c = await store.getGitConnection(accountId, provider);
    if (!c) throw new HttpError(403, "connect GitHub first (Settings → Account → Source control)", "git_not_connected");
    if (c.status !== "active") throw reauth();
    if (!c.expires_at || c.expires_at > Date.now() + REFRESH_EARLY_MS) return c;
    let p = refreshing.get(accountId);
    if (!p) {
      // Resolves to null when the connection had to be marked expired: thrown after the transaction (on Postgres)
      // commits, so the mark stays.
      const run = async (): Promise<GitConnection | null> => {
        const cur = await store.getGitConnection(accountId, provider);
        if (!cur || cur.status !== "active") return null;
        if (!cur.expires_at || cur.expires_at > Date.now() + REFRESH_EARLY_MS) return cur;
        const t = cur.refresh_token ? await oauth({ grant_type: "refresh_token", refresh_token: cur.refresh_token }) : null;
        if (!t?.access_token) {
          // Only the user's grant being gone means reconnecting; anything else (say the operator's client secret is
          // wrong) is this server's problem, and the connection stays.
          if (t && t.error !== "bad_refresh_token") throw new HttpError(502, `GitHub refused to refresh the token: ${t.error_description ?? t.error ?? "unknown error"}`, "github_error");
          await store.expireGitConnection(accountId, provider, cur.gen);
          return null;
        }
        const fields = { ...tokenFields(t), scopes: t.scope ?? cur.scopes };
        // Disconnected or reconnected meanwhile: that one stands.
        if (!await store.refreshGitConnection(accountId, provider, cur.gen, fields)) return store.getGitConnection(accountId, provider).then((x) => x?.status === "active" ? x : null);
        return (await store.getGitConnection(accountId, provider)) ?? null;
      };
      p = (store.db.dialect === "postgres" ? store.serialized(`cresslet:git-refresh:${accountId}`, run) : run())
        .then((x) => x ?? Promise.reject(reauth()))
        .finally(() => refreshing.delete(accountId));
      refreshing.set(accountId, p);
    }
    return p;
  }

  /** GitHub as this account (never anyone else: an app's collaborators each use their own). */
  async function as(acct: Account) {
    const conn = await connection(acct.id);
    const client = new GitHub({
      apiUrl: gh!.apiUrl,
      webUrl: gh!.webUrl,
      token: conn.access_token,
      // A refresh in flight replaces these tokens (and GitHub revokes them as it does): then this 401 is stale.
      unauthorized: async () => {
        await refreshing.get(acct.id)?.catch(() => {});
        await store.expireGitConnection(acct.id, provider, conn.gen);
      },
      limits: { files: cfg.limits.deployFiles, bytes: cfg.limits.deployBytes },
    });
    return { client, conn, author: { name: conn.login, email: conn.email } };
  }

  const repoView = (r: AppRepo) => ({
    provider: r.provider,
    owner: r.owner,
    name: r.name,
    fullName: `${r.owner}/${r.name}`,
    url: `${gh?.webUrl ?? cfg.git.webUrl}/${r.owner}/${r.name}`,
    defaultBranch: r.default_branch,
    subdir: r.subdir,
    deleteBranch: !!r.delete_branch,
    /** Submit the stack (its pull requests) after each change. */
    stackAutoSubmit: !!r.stack_auto_submit,
    lastSyncedSha: r.last_synced_sha,
    /** The default branch's latest commit a webhook reported (null: none, or webhooks off). */
    upstreamSha: r.upstream_sha ?? null,
    connectedAt: new Date(r.connected_at).toISOString(),
  });

  // ---- connecting an account (OAuth web flow: the studio starts it with its token, the browser carries the state)
  app.get("/me/git", async (c) => {
    const a = accountWide(c, "read");
    const conn = gh ? await store.getGitConnection(a.id, provider) : undefined;
    return c.json({
      provider,
      available: !!gh,
      kind: gh?.kind ?? null,
      connected: !!conn,
      login: conn?.login ?? null,
      status: conn?.status ?? null,
      installUrl: gh?.installUrl ?? null,
    });
  });

  app.delete("/me/git/:provider", async (c) => {
    const a = accountWide(c, "admin");
    if (c.req.param("provider") !== provider) throw new HttpError(404, "unknown provider", "not_found");
    const conn = await store.getGitConnection(a.id, provider);
    if (!conn) throw new HttpError(404, "not connected", "not_found");
    await store.deleteGitConnection(a.id, provider);
    // Best effort: revoke the token on GitHub too (the user can also do it there).
    if (gh) {
      await fetch(`${gh.apiUrl}/applications/${encodeURIComponent(gh.clientId)}/token`, {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Basic ${Buffer.from(`${gh.clientId}:${gh.clientSecret}`).toString("base64")}`,
          "content-type": "application/json",
          "user-agent": "cresslet",
        },
        body: JSON.stringify({ access_token: conn.access_token }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }
    return c.json({ disconnected: provider });
  });

  // The studio POSTs (with its token) and navigates to `url`; the state cookie binds the flow to this browser and
  // the state to this account. `returnTo`: a studio path to come back to.
  app.post("/git/github/connect", async (c) => {
    const a = accountWide(c, "admin");
    if (!gh) throw notConfigured();
    const { returnTo } = await body<{ returnTo?: unknown } | null>(c) ?? {};
    const back = typeof returnTo === "string" && /^\/(?![/\\])[^\s#\\]{0,500}$/.test(returnTo) ? returnTo : "/settings";
    const now = Date.now();
    for (const [k, v] of states) if (v.exp < now) states.delete(k);
    const state = id("gs", 16);
    states.set(state, { accountId: a.id, returnTo: back, exp: now + STATE_TTL });
    setCookie(c, STATE_COOKIE, state, { path: "/", httpOnly: true, sameSite: "Lax", secure: cfg.scheme === "https", maxAge: STATE_TTL / 1000 });
    const q = new URLSearchParams({ client_id: gh.clientId, redirect_uri: rootUrl(cfg) + gh.callbackPath, state });
    if (gh.scope) q.set("scope", gh.scope);
    return c.json({ url: `${gh.webUrl}/login/oauth/authorize?${q}` });
  });

  const callback = async (c: Context<Env>) => {
    const { code, state, error, error_description } = c.req.query();
    const cookie = getCookie(c, STATE_COOKIE);
    // Consumed only by the browser it was issued to (a stray callback doesn't cancel a flow in progress).
    const s = state && state === cookie ? states.get(state) : undefined;
    if (s) {
      states.delete(state);
      deleteCookie(c, STATE_COOKIE, { path: "/", secure: cfg.scheme === "https" });
    }
    const back = (hash: Record<string, string>) => c.redirect(`${rootUrl(cfg)}${s?.returnTo ?? "/settings"}#${new URLSearchParams(hash)}`);
    try {
      if (!gh) throw notConfigured();
      if (error) throw new HttpError(400, error_description ?? error);
      // Bound to the browser that started it (no connecting someone else's GitHub to your account, or yours to theirs).
      if (!code || !s || s.exp < Date.now()) throw new HttpError(400, "connecting GitHub expired, try again");
      const t = await oauth({ code, redirect_uri: rootUrl(cfg) + gh.callbackPath });
      if (!t.access_token) throw new HttpError(400, t.error_description ?? t.error ?? "GitHub didn't connect");
      const api = (path: string) => fetch(gh.apiUrl + path, {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${t.access_token}`, "user-agent": "cresslet" },
        signal: AbortSignal.timeout(10_000),
      }).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => null) }));
      const u = await api("/user");
      const user = u.body as { id?: number; login?: string } | null;
      if (!u.ok || !user?.id || !user.login) throw new HttpError(502, "couldn't read your GitHub user", "github_error");
      // Commits are authored with a verified email (primary first), else GitHub's noreply address for the user.
      const e = await api("/user/emails").catch(() => ({ ok: false, body: null }));
      const emails = e.ok && Array.isArray(e.body) ? (e.body as { email: string; primary: boolean; verified: boolean }[]) : [];
      const email = emails.filter((x) => x.verified).sort((x, y) => Number(y.primary) - Number(x.primary))[0]?.email ??
        `${user.id}+${user.login}@users.noreply.github.com`;
      const acct = await store.accountById(s.accountId);
      if (!acct || acct.disabled_at) throw new HttpError(400, "your Cresslet account is gone or disabled");
      await store.upsertGitConnection({
        account_id: s.accountId, provider, provider_uid: String(user.id), login: user.login, email, ...tokenFields(t),
      });
      return back({ cresslet_git: "connected" });
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      return back({ cresslet_git_error: err instanceof HttpError ? err.message : "connecting GitHub failed" });
    }
  };
  app.get("/git/github/callback", callback);

  // ---- repositories the user can push to, and new ones (as the user)
  app.get("/git/github/repos", async (c) => {
    const { client } = await as(accountWide(c, "read"));
    return c.json({ repos: await client.listRepos() });
  });

  app.post("/git/github/repos", async (c) => {
    const { client, conn } = await as(accountWide(c, "admin"));
    const input = await body<{ name?: unknown; owner?: unknown; private?: unknown; description?: unknown } | null>(c) ?? {};
    if (typeof input.name !== "string" || !REPO_PART_RE.test(input.name)) throw new HttpError(400, "name: 1-100 letters, digits, . _ -");
    if (input.owner != null && (typeof input.owner !== "string" || !REPO_PART_RE.test(input.owner))) throw new HttpError(400, "owner must be a GitHub user or organization");
    const owner = typeof input.owner === "string" && input.owner.toLowerCase() !== conn.login.toLowerCase() ? input.owner : undefined;
    const repo = await client.createRepo({
      owner, name: input.name, private: input.private !== false,
      description: typeof input.description === "string" ? input.description.slice(0, 300) : undefined,
    });
    return c.json({ repo }, 201);
  });

  // ---- an app's repository
  const linked = async (c: Context<Env>, role: Role) => {
    const a = await getApp(c.req.param("name") ?? "");
    if (a.kind === "page") throw new HttpError(409, `${a.name} is an artifact: it can't sync with a repository`, "is_page");
    await authorize(c, a, role, { account: true });
    const repo = await store.getAppRepo(a.id);
    if (!repo) throw new HttpError(404, `${a.name} isn't connected to a repository`, "git_not_linked");
    const gh = await as(c.get("account")!);
    // By its id, not the name it had: a renamed or transferred repository is followed, and another one given the
    // old name isn't written to by a later request. (One renamed, and its name reused, while this request runs isn't
    // covered: calls below go by name.)
    const info = await gh.client.repoById(repo.repo_id);
    if (info.owner !== repo.owner || info.name !== repo.name || info.defaultBranch !== repo.default_branch) {
      await store.updateAppRepoSync(repo, { owner: info.owner, name: info.name, defaultBranch: info.defaultBranch });
    }
    const now = { ...repo, owner: info.owner, name: info.name, default_branch: info.defaultBranch };
    return { a, repo: now, info, r: { owner: info.owner, name: info.name }, ...gh };
  };
  const branchName = (v: unknown, what = "branch") => {
    if (typeof v !== "string" || !BRANCH_RE.test(v)) throw new HttpError(400, `${what} must be a branch name`);
    return v;
  };
  const shaOf = (v: unknown, what: string) => {
    if (typeof v !== "string" || !SHA_RE.test(v)) throw new HttpError(400, `${what} must be a full commit SHA`);
    return v;
  };
  const message = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, 5000) : fallback;

  app.post("/apps/:name/git/connect", async (c) => {
    const a = await getApp(c.req.param("name"));
    if (a.kind === "page") throw new HttpError(409, `${a.name} is an artifact: it can't sync with a repository`, "is_page");
    // Which repository it reaches is the account's to choose (an app-scoped token can't point it at another).
    accountWide(c, "admin");
    await authorize(c, a, "admin", { account: true });
    if (!a.account_id && !a.org_id) throw new HttpError(409, `${a.name} has no owner: an anonymous app can't connect a repository`, "unclaimed");
    const input = await body<{
      owner?: unknown; repo?: unknown; subdir?: unknown; deleteBranch?: unknown; initialSync?: unknown; files?: unknown; message?: unknown;
    } | null>(c, deployBodyLimit) ?? {};
    await authorize(c, a, "admin", { account: true }); // again: access may have changed while the body arrived
    if (typeof input.owner !== "string" || !REPO_PART_RE.test(input.owner) || typeof input.repo !== "string" || !REPO_PART_RE.test(input.repo)) {
      throw new HttpError(400, "owner and repo required (the GitHub repository's owner and name)");
    }
    const initialSync = input.initialSync ?? "none";
    if (initialSync !== "push" && initialSync !== "pull" && initialSync !== "deploy" && initialSync !== "none") {
      throw new HttpError(400, "initialSync must be push, pull, deploy or none");
    }
    let subdir = "";
    if (input.subdir != null && input.subdir !== "") {
      if (typeof input.subdir !== "string") throw new HttpError(400, "subdir must be a path");
      subdir = safePath(input.subdir.replace(/\/+$/, ""));
    }
    let files = initialSync === "push" ? sourceFiles(cfg, input.files as DeployFile[]) : null;
    if (initialSync === "deploy") {
      // The live deploy's own source (an app deployed before it had a repository, from the CLI or another studio).
      const live = (await store.appById(a.id))?.current_deploy_id; // as of now: a deploy may have landed meanwhile
      const source = live ? await deploySource(cfg, a.id, live) : null;
      if (!source?.length) throw new HttpError(409, `${a.name}'s live deploy has no source to push (deployed without it)`, "no_source");
      files = sourceFiles(cfg, source.map(([path, b]) => ({ path, data: Buffer.from(b).toString("base64"), encoding: "base64" })));
    }
    const { client, author } = await as(c.get("account")!);
    const r = { owner: input.owner, name: input.repo };
    const info = await client.repo(r);
    if (!info.push) throw new HttpError(403, `you can't push to ${info.fullName} on GitHub`, "git_forbidden");
    let sha = await client.branchHead(r, info.defaultBranch);
    let out: DeployFile[] | undefined;
    if (files) {
      sha ??= await client.initialize(r, info.defaultBranch, author);
      sha = (await client.commitTree(r, {
        branch: info.defaultBranch, baseSha: sha, subdir, files, author,
        message: message(input.message, `Sync ${a.name} from Cresslet`),
      })).sha;
    } else if (initialSync === "pull") {
      if (!sha) throw new HttpError(409, `${info.fullName} is empty: nothing to pull`, "repo_empty");
      out = await client.readTree(r, sha, subdir);
    }
    await store.setAppRepo({
      app_id: a.id, provider, repo_id: info.id, owner: info.owner, name: info.name, default_branch: info.defaultBranch, subdir,
      delete_branch: input.deleteBranch === false ? 0 : 1, connected_by: c.get("account")!.id, last_synced_sha: sha,
    });
    return c.json({ repo: repoView((await store.getAppRepo(a.id))!), sha, ...(out ? { files: out } : {}) }, 201);
  });

  app.delete("/apps/:name/git", async (c) => {
    const a = await getApp(c.req.param("name"));
    await authorize(c, a, "admin", { account: true });
    if (!await store.deleteAppRepo(a.id)) throw new HttpError(404, `${a.name} isn't connected to a repository`, "git_not_linked");
    return c.json({ disconnected: true });
  });

  app.get("/apps/:name/git/status", async (c) => {
    const { repo, info, r, client } = await linked(c, "read");
    const branches = await client.listBranches(r);
    return c.json({
      repo: repoView(repo),
      defaultBranch: info.defaultBranch,
      mainSha: branches.find((b) => b.name === info.defaultBranch)?.sha ?? null,
      branches,
    });
  });

  app.post("/apps/:name/git/branches", async (c) => {
    const { r, repo, client } = await linked(c, "deploy");
    const input = await body<{ name?: unknown; from?: unknown } | null>(c) ?? {};
    const name = branchName(input.name, "name");
    const from = input.from != null ? shaOf(input.from, "from") : await client.branchHead(r, repo.default_branch);
    if (!from) throw new HttpError(409, `${repo.owner}/${repo.name} has no ${repo.default_branch} branch yet`, "repo_empty");
    await client.createBranch(r, name, from);
    return c.json({ branch: { name, sha: from } }, 201);
  });

  app.get("/apps/:name/git/tree", async (c) => {
    const { r, repo, client } = await linked(c, "read");
    const ref = c.req.query("ref") || repo.default_branch;
    let sha: string | null;
    if (SHA_RE.test(ref)) sha = ref;
    else sha = await client.branchHead(r, branchName(ref, "ref"));
    if (!sha) throw new HttpError(404, `no branch ${ref} on GitHub`, "branch_not_found");
    const files = await client.readTree(r, sha, repo.subdir);
    if (ref === repo.default_branch) await store.updateAppRepoSync(repo, { sha });
    c.header("cache-control", "no-store"); // private project source
    return c.json({ ref, sha, files });
  });

  // One commit making the branch hold exactly `files` (the workspace). `baseSha`: the commit the workspace is on;
  // if the branch has moved since, 409 and nothing is written (pull, then sync again).
  app.post("/apps/:name/git/sync", async (c) => {
    await linked(c, "deploy"); // before reading what may be a large body
    const input = await body<{ branch?: unknown; baseSha?: unknown; files?: unknown; message?: unknown; mergeParent?: unknown } | null>(c, deployBodyLimit) ?? {};
    const { a, r, repo, client, author } = await linked(c, "deploy");
    const mergeParent = input.mergeParent != null ? shaOf(input.mergeParent, "mergeParent") : undefined;
    if (mergeParent && mergeParent === input.baseSha) throw new HttpError(400, "mergeParent must be another commit than baseSha");
    const branch = branchName(input.branch);
    const baseSha = shaOf(input.baseSha, "baseSha");
    const files = sourceFiles(cfg, input.files as DeployFile[]);
    // With the app's stack changes (in this process): a change added meanwhile doesn't turn this one into a lower one.
    const out = await locked(a.id, async () => {
      // (A change below its stack's top only for an Update stack merge resolved there: its record follows.)
      const restacked = await assertSyncable({ provider: client, store, appId: a.id, repo, r }, branch, mergeParent);
      const head = await client.branchHead(r, branch);
      if (!head) throw new HttpError(404, `no branch ${branch} on GitHub`, "branch_not_found");
      if (head !== baseSha) {
        throw Object.assign(conflict(`${branch} moved on GitHub since this workspace loaded it: pull first`), { extra: { headSha: head } });
      }
      const out = await client.commitTree(r, { branch, baseSha, subdir: repo.subdir, files, author, mergeParent, message: message(input.message, mergeParent ? `Merge ${repo.default_branch} into ${branch}` : `Update ${a.name}`) });
      if (branch === repo.default_branch) await store.updateAppRepoSync(repo, { sha: out.sha, upstream: out.sha });
      else if (restacked) {
        if (out.changed && restacked.sha === baseSha) await store.setStackChangeSha(restacked.id, out.sha);
      }
      // Onto a stack's top change from where it's recorded (a hand edit pushed, a merge resolved): the change follows.
      else if (out.changed) await followed({ provider: client, store, appId: a.id, repo, r }, branch, baseSha, out.sha).catch((e) => console.error(e));
      return out;
    });
    return c.json({ branch, ...out });
  });

  // Stacked changes (server/stack.ts): the app's open stacks, checked against GitHub.
  app.get("/apps/:name/git/stack", async (c) => {
    const { a, r, repo, client } = await linked(c, "read");
    const ctx = { provider: client, store, appId: a.id, repo, r };
    // `protected`: why the default branch takes no direct moves (stacks land through their pull requests), or null.
    const [stacks, guarded] = await Promise.all([
      readStacks(ctx),
      client.branchProtection(r, repo.default_branch).catch(() => `${repo.default_branch}'s protection couldn't be read`),
    ]);
    c.header("cache-control", "no-store");
    return c.json({ defaultBranch: repo.default_branch, protected: guarded, stacks });
  });
  // Pull requests for a stack's changes (opened or updated as the user), and their review and checks.
  app.post("/apps/:name/git/stack/submit", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ stack?: unknown } | null>(c) ?? {};
    if (typeof input.stack !== "string") throw new HttpError(400, "stack must be a stack's id");
    return c.json(await submitStack({ provider: client, store, appId: a.id, repo, r }, input.stack));
  });
  app.get("/apps/:name/git/stack/pulls", async (c) => {
    const { a, r, repo, client } = await linked(c, "read");
    const stack = c.req.query("stack");
    if (!stack) throw new HttpError(400, "stack must be a stack's id");
    c.header("cache-control", "no-store");
    return c.json({ pulls: await stackPulls({ provider: client, store, appId: a.id, repo, r }, stack) });
  });
  // The app's source control settings.
  app.patch("/apps/:name/git", async (c) => {
    const a = await getApp(c.req.param("name"));
    await authorize(c, a, "admin", { account: true });
    const repo = await store.getAppRepo(a.id);
    if (!repo) throw new HttpError(404, `${a.name} isn't connected to a repository`, "git_not_linked");
    const input = await body<{ stackAutoSubmit?: unknown } | null>(c) ?? {};
    if (input.stackAutoSubmit !== undefined) {
      if (typeof input.stackAutoSubmit !== "boolean") throw new HttpError(400, "stackAutoSubmit must be true or false");
      await store.setStackAutoSubmit(a.id, input.stackAutoSubmit);
    }
    return c.json({ repo: repoView((await store.getAppRepo(a.id))!) });
  });
  // A change's branch pushed to on GitHub: pulled in as the top of its stack, or carried on from as a branch of its own.
  for (const [path, fn] of [["pull-in", pullIn], ["carry-on", carryOn]] as const) {
    app.post(`/apps/:name/git/stack/${path}`, async (c) => {
      const { a, r, repo, client } = await linked(c, "deploy");
      const input = await body<{ change?: unknown; sha?: unknown } | null>(c) ?? {};
      if (typeof input.change !== "string") throw new HttpError(400, "change must be a change's id");
      return c.json(await fn({ provider: client, store, appId: a.id, repo, r }, input.change, shaOf(input.sha, "sha")));
    });
  }
  // Changes set aside, listed (Source control), and deleted.
  app.get("/apps/:name/git/stack/aside", async (c) => {
    const { a, r, repo, client } = await linked(c, "read");
    c.header("cache-control", "no-store");
    return c.json({ changes: await setAsideBranches({ provider: client, store, appId: a.id, repo, r }) });
  });
  app.post("/apps/:name/git/stack/aside/delete", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ change?: unknown } | null>(c) ?? {};
    if (typeof input.change !== "string") throw new HttpError(400, "change must be a change's id");
    return c.json(await deleteSetAside({ provider: client, store, appId: a.id, repo, r }, input.change));
  });
  // Undoing a change below the top: the workspace's files for a new change that reverses it (conflicts marked).
  app.get("/apps/:name/git/stack/undo", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const change = c.req.query("change");
    if (!change) throw new HttpError(400, "change must be a change's id");
    const seen = c.req.query("sha") != null ? { sha: shaOf(c.req.query("sha"), "sha"), base: shaOf(c.req.query("base"), "base") } : undefined;
    c.header("cache-control", "no-store");
    return c.json(await undoPlan({ provider: client, store, appId: a.id, repo, r }, change, seen));
  });
  // Folding a change into the one below it.
  app.post("/apps/:name/git/stack/fold", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ change?: unknown; into?: unknown } | null>(c) ?? {};
    if (typeof input.change !== "string") throw new HttpError(400, "change must be a change's id");
    if (typeof input.into !== "string" || !input.into) throw new HttpError(400, "into must be the id of the change below it");
    return c.json(await fold({ provider: client, store, appId: a.id, repo, r }, input.change, input.into));
  });
  // Landing a stack up to a change (the default branch moved to it, change by change).
  app.post("/apps/:name/git/stack/land", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ change?: unknown } | null>(c) ?? {};
    if (typeof input.change !== "string") throw new HttpError(400, "change must be a change's id");
    const out = await landUpTo({ provider: client, store, appId: a.id, repo, r }, input.change);
    await store.updateAppRepoSync(repo, { sha: out.sha, upstream: out.sha }).catch((e) => console.error(e));
    return c.json(out);
  });
  // Update stack: the default branch brought into each change, from the bottom up (stops at a conflict).
  app.post("/apps/:name/git/stack/restack", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ stack?: unknown } | null>(c) ?? {};
    if (typeof input.stack !== "string") throw new HttpError(400, "stack must be a stack's id");
    return c.json(await restack({ provider: client, store, appId: a.id, repo, r }, input.stack));
  });
  // Landing the bottom change through its pull request (a default branch that needs them), and bringing it up to date.
  app.post("/apps/:name/git/stack/land-next", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ change?: unknown; sha?: unknown } | null>(c) ?? {};
    if (typeof input.change !== "string") throw new HttpError(400, "change must be a change's id");
    const out = await landNext({ provider: client, store, appId: a.id, repo, r }, input.change, input.sha != null ? shaOf(input.sha, "sha") : undefined);
    // (Merged here: the default branch is there now. One merged on GitHub before: a webhook may have said where since.)
    if (!out.before) await store.updateAppRepoSync(repo, { sha: out.sha, upstream: out.sha }).catch((e) => console.error(e));
    return c.json(out);
  });
  app.post("/apps/:name/git/stack/update", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ change?: unknown; sha?: unknown } | null>(c) ?? {};
    if (typeof input.change !== "string") throw new HttpError(400, "change must be a change's id");
    return c.json(await updateBottom({ provider: client, store, appId: a.id, repo, r }, input.change, input.sha != null ? shaOf(input.sha, "sha") : undefined));
  });
  // Going back to a change (the ones above it set aside), and putting them back.
  app.post("/apps/:name/git/stack/back", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ change?: unknown; sha?: unknown; top?: unknown; topSha?: unknown } | null>(c) ?? {};
    if (typeof input.change !== "string") throw new HttpError(400, "change must be a change's id");
    if (input.top != null && typeof input.top !== "string") throw new HttpError(400, "top must be a change's id");
    const top = typeof input.top === "string" ? { id: input.top, sha: shaOf(input.topSha, "topSha") } : undefined;
    return c.json(await goBack({ provider: client, store, appId: a.id, repo, r }, input.change, input.sha != null ? shaOf(input.sha, "sha") : undefined, top));
  });
  app.post("/apps/:name/git/stack/restore", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ stack?: unknown; only?: unknown; top?: unknown; sha?: unknown } | null>(c) ?? {};
    if (typeof input.stack !== "string") throw new HttpError(400, "stack must be a stack's id");
    if (input.only != null && (!Array.isArray(input.only) || !input.only.every((x) => typeof x === "string"))) throw new HttpError(400, "only must be change ids");
    if (input.top != null && typeof input.top !== "string") throw new HttpError(400, "top must be a change's id");
    const top = typeof input.top === "string" ? { id: input.top, sha: shaOf(input.sha, "sha") } : undefined;
    return c.json(await restore({ provider: client, store, appId: a.id, repo, r }, input.stack, { only: input.only as string[] | undefined, top }));
  });
  // The workspace committed as a new change: on the default branch a new stack, on a stack's top change the next one.
  app.post("/apps/:name/git/stack", async (c) => {
    await linked(c, "deploy"); // before reading what may be a large body
    const input = await body<{ from?: unknown; baseSha?: unknown; files?: unknown; title?: unknown; prompt?: unknown; submit?: unknown } | null>(c, deployBodyLimit) ?? {};
    const { a, r, repo, client, author } = await linked(c, "deploy");
    const from = branchName(input.from, "from");
    const baseSha = shaOf(input.baseSha, "baseSha");
    const files = sourceFiles(cfg, input.files as DeployFile[]);
    const ctx = { provider: client, store, appId: a.id, repo, r };
    const out = await commitChange(ctx, {
      from, baseSha, files, author, by: c.get("account")!.id,
      title: message(input.title, `Update ${a.name}`).split("\n")[0].slice(0, 200),
      prompt: typeof input.prompt === "string" ? input.prompt.slice(0, 5000) : "",
    });
    // The app submits its stacks after each change (not one the studio makes on its way somewhere, `submit: false`):
    // the change is made whatever happens to its pull requests.
    const submitted = out.changed && repo.stack_auto_submit && input.submit !== false
      ? await submitStack(ctx, out.stack.id).catch((e) => ({ pulls: [], error: e instanceof HttpError ? e.message : "couldn't submit the stack" }))
      : undefined;
    return c.json({ ...out, ...(submitted ? { submitted } : {}) }, out.changed ? 201 : 200);
  });

  // Merge `branch` into the default branch (or `into`), as the user: a fast-forward when it can, else a merge
  // commit. `treeChanged`: the result isn't `branch`'s tree (the default branch had commits of its own), so its
  // files come back for the workspace to build from.
  app.post("/apps/:name/git/merge", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ branch?: unknown; into?: unknown; message?: unknown; headSha?: unknown } | null>(c) ?? {};
    const branch = branchName(input.branch);
    const into = input.into != null ? branchName(input.into, "into") : repo.default_branch;
    const expect = input.headSha != null ? shaOf(input.headSha, "headSha") : undefined;
    const ctx = { provider: client, store, appId: a.id, repo, r };
    if (into === repo.default_branch) await assertNotBelowTop(ctx, branch);
    // A stack's top into the default branch: landed change by change when it can (its pull requests merged, each with
    // its own turn); when it can't (the default branch moved, a change pushed to), merged as before.
    let m: MergeResult | undefined, stackLanded: { stack: string; changes: number; deleted: string[]; pullErrors?: PullError[] } | undefined;
    const top = into === repo.default_branch ? (await store.openStackChanges(a.id)).find((x) => x.branch === branch) : undefined;
    if (top) {
      try {
        const l = await landUpTo(ctx, top.id, expect);
        m = { mergedSha: l.sha, headSha: l.sha, fastForward: true, treeChanged: false };
        stackLanded = { stack: l.stack, changes: l.landed.length, deleted: l.deleted, ...(l.pullErrors ? { pullErrors: l.pullErrors } : {}) };
      } catch (e) {
        // A protected default branch is refused (Cresslet checks it first: GitHub lets an admin, or a user allowed to
        // bypass it, through), and a change gone on GitHub. The rest merge as before: the default branch moved, a change
        // pushed to, a commit other than the one synced (the merge checks it against GitHub).
        const asBefore = ["default_moved", "moved", "not_synced"].includes((e as HttpError).code);
        if (!(e instanceof HttpError) || !asBefore) throw e;
      }
    }
    m ??= await client.merge(r, { into, head: branch, expect, message: message(input.message, `Merge ${branch} into ${into}`) });
    if (into === repo.default_branch) await store.updateAppRepoSync(repo, { sha: m.mergedSha, upstream: m.mergedSha }).catch((e) => console.error(e));
    // The merge happened: from here on it's reported, whatever else fails. Its files (when they differ from the
    // branch's) before the branch goes, so a failure to load them leaves the branch to retry from.
    let files: DeployFile[] | undefined, filesError: string | undefined;
    if (m.treeChanged) {
      try {
        files = await client.readTree(r, m.mergedSha, repo.subdir);
      } catch (e) {
        filesError = e instanceof HttpError ? e.message : "couldn't load the merged files";
      }
    }
    // A stack's top change merged: the stack is in. Its lower branches go with the top's (not when the files didn't
    // load: the branch is kept to retry from).
    const stack = stackLanded ?? (into === repo.default_branch
      ? await landed(ctx, { branch, headSha: m.headSha, mergedSha: m.mergedSha, deleteBelow: !filesError }).catch((e) => (console.error(e), null))
      : null);
    // A stack's own cleanup decided about its branches (the merged one too: not under a pull request still open).
    let deletedBranch = !!stack?.deleted.includes(branch);
    // Only while it's still the commit that was merged: a push since then keeps it. (GitHub can't delete a ref
    // conditionally, so a push in between this check and the delete isn't excluded, only unlikely.)
    if (!stack && !filesError && repo.delete_branch && branch !== into && branch !== repo.default_branch && await client.branchHead(r, branch).catch(() => null) === m.headSha) {
      deletedBranch = await client.deleteBranch(r, branch).catch(() => false);
    }
    const { headSha: _, ...out } = m;
    const landedOut = stack ? { stack: stack.stack, changes: stack.changes, ...(stack.pullErrors ? { pullErrors: stack.pullErrors } : {}) } : null;
    return c.json({ ...out, branch: into, deletedBranch, ...(landedOut ? { landed: landedOut } : {}), ...(files ? { files } : {}), ...(filesError ? { filesError } : {}) });
  });

  // The default branch merged into `branch`, conflicts marked, for the workspace to resolve (then sync with
  // `mergeParent: intoSha`, and Deploy fast-forwards).
  app.get("/apps/:name/git/conflicts", async (c) => {
    const { r, repo, client } = await linked(c, "deploy");
    const branch = branchName(c.req.query("branch"));
    // `with`: the branch merged in (default: the default branch; Update stack: the change below).
    const into = c.req.query("with") ? branchName(c.req.query("with"), "with") : repo.default_branch;
    if (branch === into) throw new HttpError(400, `${branch} is ${into}: there's nothing to merge into it`);
    const out = await client.conflicts(r, { into, head: branch, subdir: repo.subdir });
    c.header("cache-control", "no-store");
    return c.json({ branch, into, ...out });
  });

  // Pull requests, when the default branch takes no direct merges (protection, required reviews or checks).
  app.get("/apps/:name/git/pulls", async (c) => {
    const { a, r, repo, client } = await linked(c, "read");
    const branch = branchName(c.req.query("branch"));
    // A change of a stack: its pull request is the stack's (into the change below).
    const stacked = await changePull({ provider: client, store, appId: a.id, repo, r }, branch, false);
    return c.json({ pull: stacked ? stacked.pull : await client.pull(r, branch, repo.default_branch) });
  });
  app.post("/apps/:name/git/pulls", async (c) => {
    const { a, r, repo, client } = await linked(c, "deploy");
    const input = await body<{ branch?: unknown; title?: unknown; body?: unknown } | null>(c) ?? {};
    const branch = branchName(input.branch);
    if (branch === repo.default_branch) throw new HttpError(400, `a pull request needs a branch other than ${branch}`);
    // A change of a stack: its stack is submitted (one pull request per change), not a second one into the default branch.
    const stacked = await changePull({ provider: client, store, appId: a.id, repo, r }, branch, true);
    if (stacked) return c.json({ pull: stacked.pull, ...(stacked.errors ? { stackErrors: stacked.errors } : {}) }, stacked.created ? 201 : 200);
    const { pull, created } = await client.openPull(r, {
      head: branch, base: repo.default_branch,
      title: message(input.title, `Update ${a.name} (${branch})`).split("\n")[0].slice(0, 200),
      body: typeof input.body === "string" ? input.body.slice(0, 10_000) : `Opened from Cresslet: merging it lets ${a.name} deploy from ${repo.default_branch}.`,
    });
    return c.json({ pull }, created ? 201 : 200);
  });

  // GitHub's webhook (the GitHub App's, or a repository's): pushes to a linked repository's default branch are
  // noted, so open studios can say it moved. Signed with CRESSLET_GITHUB_WEBHOOK_SECRET.
  app.post("/webhooks/github", async (c) => {
    const secret = cfg.git.webhookSecret;
    if (!secret) throw new HttpError(404, "webhooks aren't set up on this server", "not_found");
    const raw = await readBody(c.req.raw, 5 * 1024 * 1024); // capped while it's read: anyone can send this
    const sig = Buffer.from(c.req.header("x-hub-signature-256") ?? "");
    const want = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
    if (sig.byteLength !== want.byteLength || !timingSafeEqual(sig, want)) throw new HttpError(401, "bad signature", "unauthorized");
    const event = c.req.header("x-github-event");
    if (event !== "push") return c.json({ ok: true, ignored: event ?? null });
    let p: { ref?: string; after?: string; deleted?: boolean; repository?: { id?: number } };
    try {
      p = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new HttpError(400, "invalid JSON body", "bad_request");
    }
    const branch = p.ref?.startsWith("refs/heads/") ? p.ref.slice(11) : null;
    if (!branch || !p.repository?.id || p.deleted || !p.after || !SHA_RE.test(p.after)) return c.json({ ok: true, ignored: "push" });
    const apps = await store.noteUpstreamPush(String(p.repository.id), branch, p.after);
    return c.json({ ok: true, apps });
  });

  return { repoView, callback };
}
