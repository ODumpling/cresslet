// A small in-memory GitHub for the source control tests (tests/git_test.ts): OAuth (code, refresh), users, and the
// REST endpoints server/git.ts calls, over a toy git (flat trees, real blob ids).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type GhUser = { id: number; login: string; email: string };
type Entry = { mode: string; sha: string };
type Commit = { tree: Map<string, Entry>; parents: string[]; message: string; author: { name: string; email: string } | null; by: string };
type Pull = { number: number; head: string; base: string; title: string; body: string; state: "open" | "closed"; merged?: boolean; mergeSha?: string; mergedHead?: string; comments?: string[]; reviews: { user: { login: string }; state: string }[] };
type Repo = {
  id: number; owner: string; name: string; private: boolean; default_branch: string; push: Set<string>; refs: Map<string, string>;
  protected: Set<string>; rulesets?: boolean; pulls: Pull[];
  /**
   * Pull request merging: the methods allowed (default all), an approving review required, approvals dismissed when a
   * pull request's base changes, branches up to date with their base required, the head deleted on merge (and the
   * pull requests on it moved to its base), as GitHub's settings.
   */
  allow?: { merge: boolean; squash: boolean; rebase: boolean }; requireReview?: boolean; dismissStale?: boolean; strict?: boolean; deleteOnMerge?: boolean;
};

const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");
const blobId = (b: Buffer) => sha1(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]));

export async function fakeGithub(opts: { clientId: string; clientSecret: string }) {
  const users = new Map<string, GhUser>(); // login → user
  const tokens = new Map<string, { user: GhUser; exp: number | null }>(); // access token → user
  const refreshTokens = new Map<string, GhUser>(); // single-use
  const codes = new Map<string, GhUser>();
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, Entry>>();
  const commits = new Map<string, Commit>();
  const repos = new Map<string, Repo>(); // "owner/name"
  const stats = { refreshes: 0, calls: [] as { login: string; method: string; path: string }[] };
  let expiresIn = 0; // seconds; 0 = tokens don't expire
  let badSecret = false;
  const checks = new Map<string, { status: string; conclusion: string | null }[]>(); // commit → check runs
  let authorizeAs: GhUser | null = null;
  let n = 0;

  const treeId = (t: Map<string, Entry>) => {
    const id = sha1(JSON.stringify([...t].sort(([a], [b]) => (a < b ? -1 : 1))));
    trees.set(id, new Map(t));
    return id;
  };
  const issue = (u: GhUser) => {
    const access = `ghu_${++n}`, refresh = `ghr_${++n}`;
    tokens.set(access, { user: u, exp: expiresIn ? Date.now() + expiresIn * 1000 : null });
    refreshTokens.set(refresh, u);
    return { access_token: access, token_type: "bearer", scope: "", ...(expiresIn ? { expires_in: expiresIn, refresh_token: refresh } : {}) };
  };
  const commit = (tree: Map<string, Entry>, parents: string[], message: string, author: Commit["author"], by: string) => {
    const id = sha1(`${treeId(tree)}:${parents.join(",")}:${message}:${++n}`);
    commits.set(id, { tree: new Map(tree), parents, message, author, by });
    return id;
  };
  const ancestors = (sha: string) => {
    const seen = new Set<string>(), todo = [sha];
    while (todo.length) {
      const s = todo.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      todo.push(...commits.get(s)!.parents);
    }
    return seen;
  };
  const mergeBase = (a: string, b: string) => {
    // The best common ancestor: one no other common ancestor descends from (as git's, past merge commits).
    const aa = ancestors(a);
    const common = [...ancestors(b)].filter((x) => aa.has(x));
    return common.find((x) => !common.some((y) => y !== x && ancestors(y).has(x))) ?? null;
  };
  /** The three-way merge of two commits' trees, or null on a conflict. */
  const merged3 = (base: string, ours: string, theirs: string) => {
    const [bt, ot, tt] = [commits.get(base)!.tree, commits.get(ours)!.tree, commits.get(theirs)!.tree];
    const out = new Map<string, Entry>();
    for (const path of new Set([...bt.keys(), ...ot.keys(), ...tt.keys()])) {
      const [b, o, t] = [bt.get(path), ot.get(path), tt.get(path)];
      let e: Entry | undefined;
      if (o?.sha === t?.sha) e = o;
      else if (o?.sha === b?.sha) e = t;
      else if (t?.sha === b?.sha) e = o;
      else return null;
      if (e) out.set(path, e);
    }
    return out;
  };
  const diff = (from: Map<string, Entry>, to: Map<string, Entry>) =>
    [...new Set([...from.keys(), ...to.keys()])].filter((p) => from.get(p)?.sha !== to.get(p)?.sha).sort().map((filename) => ({ filename }));
  const write = (r: Repo, branch: string, files: Record<string, string | null>, message = "external", by = "outside") => {
    const tree = new Map(commits.get(r.refs.get(branch)!)!.tree);
    for (const [p, d] of Object.entries(files)) {
      if (d === null) tree.delete(p);
      else {
        const b = Buffer.from(d);
        blobs.set(blobId(b), b);
        tree.set(p, { mode: "100644", sha: blobId(b) });
      }
    }
    r.refs.set(branch, commit(tree, [r.refs.get(branch)!], message, null, by));
    return r.refs.get(branch)!;
  };
  const repoJson = (r: Repo, u: GhUser) => ({
    id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, default_branch: r.default_branch,
    html_url: `https://github.example/${r.owner}/${r.name}`, owner: { login: r.owner }, permissions: { push: r.push.has(u.login) },
    allow_merge_commit: r.allow?.merge ?? true, allow_squash_merge: r.allow?.squash ?? true, allow_rebase_merge: r.allow?.rebase ?? true,
  });
  const addRepo = (owner: string, name: string, push: string[], init = true) => {
    const r: Repo = { id: ++n, owner, name, private: true, default_branch: "main", push: new Set(push), refs: new Map(), protected: new Set(), pulls: [] };
    if (init) {
      const b = Buffer.from("# " + name + "\n");
      blobs.set(blobId(b), b);
      r.refs.set("main", commit(new Map([["README.md", { mode: "100644", sha: blobId(b) }]]), [], "Initial commit", null, owner));
    }
    repos.set(`${owner}/${name}`, r);
    return r;
  };

  const readBody = async (req: IncomingMessage) => {
    let s = "";
    for await (const c of req) s += c;
    return s;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const p = url.pathname;
    const json = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const raw = await readBody(req);
    if (p === "/login/oauth/access_token") {
      const b = Object.fromEntries(new URLSearchParams(raw));
      assert.equal(b.client_id, opts.clientId);
      if (badSecret) return json(200, { error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." });
      assert.equal(b.client_secret, opts.clientSecret);
      if (b.grant_type === "refresh_token") {
        stats.refreshes++;
        const u = refreshTokens.get(b.refresh_token);
        refreshTokens.delete(b.refresh_token);
        return u ? json(200, issue(u)) : json(200, { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
      }
      const u = codes.get(b.code);
      codes.delete(b.code);
      return u ? json(200, issue(u)) : json(200, { error: "bad_verification_code" });
    }
    // The browser's side of the web flow: the user `authorizeAs` approves at once.
    if (p === "/login/oauth/authorize") {
      if (!authorizeAs) return json(403, { message: "nobody to authorize as" });
      const c = `code_${++n}`;
      codes.set(c, authorizeAs);
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", c);
      back.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (p.startsWith("/applications/") && req.method === "DELETE") {
      const t = JSON.parse(raw).access_token;
      tokens.delete(t);
      return json(204);
    }
    const auth = tokens.get(req.headers.authorization?.replace("Bearer ", "") ?? "");
    if (!auth || (auth.exp && auth.exp < Date.now())) return json(401, { message: "Bad credentials" });
    const u = auth.user;
    stats.calls.push({ login: u.login, method: req.method!, path: p });
    const body = raw ? JSON.parse(raw) : {};
    if (p === "/user") return json(200, { id: u.id, login: u.login, email: null });
    if (p === "/user/emails") return json(200, [{ email: u.email, primary: true, verified: true }]);
    if (p === "/user/repos" && req.method === "GET") {
      return json(200, [...repos.values()].filter((r) => r.push.has(u.login) || r.owner === u.login).map((r) => repoJson(r, u)));
    }
    if ((p === "/user/repos" || p.startsWith("/orgs/")) && req.method === "POST") {
      const owner = p === "/user/repos" ? u.login : p.split("/")[2];
      if (repos.has(`${owner}/${body.name}`)) return json(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
      const r = addRepo(owner, body.name, [u.login], !!body.auto_init);
      r.private = body.private;
      return json(201, repoJson(r, u));
    }
    const byId = /^\/repositories\/(\d+)$/.exec(p);
    if (byId) {
      const r = [...repos.values()].find((x) => String(x.id) === byId[1]);
      return r && (r.push.has(u.login) || r.owner === u.login) ? json(200, repoJson(r, u)) : json(404, { message: "Not Found" });
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json(404, { message: "Not Found" });
    const r = repos.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
    if (!r || !(r.push.has(u.login) || r.owner === u.login)) return json(404, { message: "Not Found" });
    const rest = m[3] ?? "";
    const canPush = r.push.has(u.login);
    if (!rest) return json(200, repoJson(r, u));
    let x: RegExpExecArray | null;
    if ((x = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      if (!r.refs.size) return json(409, { message: "Git Repository is empty." });
      const sha = r.refs.get(decodeURIComponent(x[1]));
      return sha ? json(200, { ref: `refs/heads/${x[1]}`, object: { sha, type: "commit" } }) : json(404, { message: "Not Found" });
    }
    if ((x = /^\/git\/matching-refs\/heads\/(.*)$/.exec(rest))) {
      const prefix = decodeURIComponent(x[1]);
      return json(200, [...r.refs].filter(([b]) => b.startsWith(prefix)).map(([b, sha]) => ({ ref: `refs/heads/${b}`, object: { sha, type: "commit" } })));
    }
    if ((x = /^\/branches\/(.+)\/protection$/.exec(rest))) {
      // Readable by admins (here: the owner); protection that needs status checks.
      if (u.login !== r.owner) return json(404, { message: "Not Found" });
      return r.protected.has(decodeURIComponent(x[1])) ? json(200, { required_status_checks: { strict: false, contexts: ["ci"] } }) : json(404, { message: "Branch not protected" });
    }
    if ((x = /^\/branches\/(.+)$/.exec(rest))) {
      const name = decodeURIComponent(x[1]);
      return r.refs.has(name) ? json(200, { name, commit: { sha: r.refs.get(name) }, protected: r.protected.has(name) }) : json(404, { message: "Branch not found" });
    }
    if ((x = /^\/rules\/branches\/(.+)$/.exec(rest))) {
      return json(200, r.rulesets && decodeURIComponent(x[1]) === r.default_branch ? [{ type: "pull_request" }] : []);
    }
    if (rest.startsWith("/branches")) {
      return json(200, [...r.refs].map(([name, sha]) => ({ name, commit: { sha }, protected: r.protected.has(name) })));
    }
    if (rest === "/git/refs" && req.method === "POST") {
      if (!canPush) return json(403, { message: "Resource not accessible" });
      const name = body.ref.replace(/^refs\/heads\//, "");
      if (r.refs.has(name)) return json(422, { message: "Reference already exists" });
      // A branch whose name is a folder of this one (or the other way): git can't have both.
      if ([...r.refs.keys()].some((x) => name.startsWith(x + "/") || x.startsWith(name + "/"))) return json(422, { message: "Reference update failed" });
      r.refs.set(name, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((x = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = x[1].split("/").map(decodeURIComponent).join("/");
      if (req.method === "DELETE") {
        if (!r.refs.delete(name)) return json(422, { message: "Reference does not exist" });
        // An API delete closes the pull requests from or into it (GitHub: #117's spike).
        for (const pr of r.pulls) if (pr.state === "open" && (pr.head === name || pr.base === name)) pr.state = "closed";
        return json(204);
      }
      if (!canPush) return json(403, { message: "Resource not accessible" });
      if (r.protected.has(name)) return json(422, { message: "Protected branch update failed for refs/heads/" + name });
      if (r.rulesets && name === r.default_branch) return json(422, { message: "Repository rule violations found\n\nChanges must be made through a pull request." });
      const cur = r.refs.get(name);
      if (!cur) return json(422, { message: "Reference does not exist" });
      if (!body.force && !ancestors(body.sha).has(cur)) return json(422, { message: "Update is not a fast forward" });
      r.refs.set(name, body.sha);
      // A pull request whose base now holds its head is merged (GitHub: #117's spike).
      for (const pr of r.pulls) if (pr.state === "open" && pr.base === name && r.refs.has(pr.head) && ancestors(body.sha).has(r.refs.get(pr.head)!)) Object.assign(pr, { state: "closed", merged: true });
      return json(200, { object: { sha: body.sha } });
    }
    if ((x = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const c = commits.get(x[1]);
      return c ? json(200, { sha: x[1], tree: { sha: treeId(c.tree) }, parents: c.parents.map((sha) => ({ sha })) }) : json(404, { message: "Not Found" });
    }
    if ((x = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest))) {
      const t = trees.get(x[1]);
      if (!t) return json(404, { message: "Not Found" });
      const dirs = new Set<string>();
      for (const path of t.keys()) for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) dirs.add(path.slice(0, i));
      return json(200, {
        sha: x[1], truncated: false,
        tree: [
          ...[...dirs].map((path) => ({ path, mode: "040000", type: "tree", sha: sha1(path) })),
          ...[...t].map(([path, e]) => ({ path, mode: e.mode, type: e.mode === "160000" ? "commit" : "blob", sha: e.sha, size: blobs.get(e.sha)?.length ?? 0 })),
        ],
      });
    }
    if ((x = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest))) {
      const b = blobs.get(x[1]);
      return b ? json(200, { sha: x[1], content: b.toString("base64"), encoding: "base64" }) : json(404, { message: "Not Found" });
    }
    if (rest === "/git/blobs" && req.method === "POST") {
      const b = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
      blobs.set(blobId(b), b);
      return json(201, { sha: blobId(b) });
    }
    if (rest === "/git/trees" && req.method === "POST") {
      const t = new Map(body.base_tree ? trees.get(body.base_tree)! : []);
      for (const e of body.tree) {
        if (e.sha === null) t.delete(e.path);
        else t.set(e.path, { mode: e.mode, sha: e.sha });
      }
      return json(201, { sha: treeId(t) });
    }
    if (rest === "/git/commits" && req.method === "POST") {
      return json(201, { sha: commit(trees.get(body.tree)!, body.parents, body.message, body.author ?? null, u.login) });
    }
    if ((x = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(rest))) {
      const [a, b] = [x[1], x[2]];
      const base = mergeBase(a, b)!;
      const status = a === b ? "identical" : base === a ? "ahead" : base === b ? "behind" : "diverged";
      const inBase = ancestors(base);
      const ahead = [...ancestors(b)].filter((c) => !inBase.has(c)).map((sha) => ({ sha, parents: commits.get(sha)!.parents.map((p) => ({ sha: p })) }));
      return json(200, { status, merge_base_commit: { sha: base }, total_commits: ahead.length, commits: ahead, files: diff(commits.get(base)!.tree, commits.get(b)!.tree) });
    }
    if (rest === "/merges" && req.method === "POST") {
      if (!canPush) return json(403, { message: "Resource not accessible" });
      if (r.protected.has(body.base)) return json(409, { message: "Protected branch update failed: required status checks" });
      if (r.rulesets && body.base === r.default_branch) return json(409, { message: "Repository rule violations found\n\nChanges must be made through a pull request." });
      const ours = r.refs.get(body.base)!, theirs = body.head;
      const base = mergeBase(ours, theirs)!;
      if (base === theirs) return json(204);
      const out = merged3(base, ours, theirs);
      if (!out) return json(409, { message: "Merge conflict" });
      const sha = commit(out, [ours, theirs], body.commit_message, null, u.login);
      r.refs.set(body.base, sha);
      for (const pr of r.pulls) if (pr.state === "open" && pr.base === body.base && r.refs.has(pr.head) && ancestors(sha).has(r.refs.get(pr.head)!)) Object.assign(pr, { state: "closed", merged: true });
      return json(201, { sha, commit: { tree: { sha: treeId(out) } } });
    }
    const approved = (pr: Pull) => pr.reviews.some((x) => x.state === "APPROVED") && !pr.reviews.some((x) => x.state === "CHANGES_REQUESTED");
    const behind = (pr: Pull) => r.refs.has(pr.head) && r.refs.has(pr.base) && !ancestors(r.refs.get(pr.head)!).has(r.refs.get(pr.base)!);
    const pullJson = (pr: Pull) => ({
      number: pr.number, html_url: `https://github.example/${r.owner}/${r.name}/pull/${pr.number}`, title: pr.title, body: pr.body, draft: false,
      state: pr.state, merged: !!pr.merged, head: { sha: pr.mergedHead ?? r.refs.get(pr.head) ?? "", ref: pr.head }, base: { ref: pr.base }, merge_commit_sha: pr.mergeSha ?? null,
      mergeable_state: r.requireReview && !approved(pr) ? "blocked" : r.strict && behind(pr) ? "behind" : "clean",
    });
    if (rest === "/pulls" && req.method === "GET") {
      const head = url.searchParams.get("head")?.split(":")[1], base = url.searchParams.get("base");
      return json(200, r.pulls.filter((x) => x.state === "open" && (!head || x.head === head) && (!base || x.base === base)).map(pullJson));
    }
    if (rest === "/pulls" && req.method === "POST") {
      if (!r.refs.has(body.head)) return json(422, { message: "Validation Failed", errors: [{ message: `No commits between ${body.base} and ${body.head}` }] });
      const pr: Pull = { number: r.pulls.length + 1, head: body.head, base: body.base, title: body.title, body: body.body, state: "open", reviews: [] };
      r.pulls.push(pr);
      return json(201, pullJson(pr));
    }
    if ((x = /^\/pulls\/(\d+)\/reviews$/.exec(rest))) return json(200, r.pulls[Number(x[1]) - 1]?.reviews ?? []);
    if ((x = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && req.method === "PUT") {
      const pr = r.pulls[Number(x[1]) - 1];
      if (!pr) return json(404, { message: "Not Found" });
      if (!canPush) return json(403, { message: "Resource not accessible" });
      if (pr.state !== "open") return json(405, { message: "Pull Request is not mergeable" });
      const method = body.merge_method ?? "merge";
      if (!(r.allow?.[method as "merge"] ?? true)) return json(405, { message: `${method === "merge" ? "Merge commits" : method} are not allowed on this repository.` });
      const head = r.refs.get(pr.head), into = r.refs.get(pr.base);
      if (!head || !into) return json(422, { message: "Head or base branch is missing" });
      if (body.sha && body.sha !== head) return json(409, { message: "Head branch was modified. Review and try the merge again." });
      if (r.requireReview && !approved(pr)) return json(405, { message: "At least 1 approving review is required by reviewers with write access." });
      if (r.strict && behind(pr)) return json(405, { message: "Head branch is out of date. Review and try the merge again." });
      const out = merged3(mergeBase(into, head)!, into, head);
      if (!out) return json(405, { message: "Pull Request is not mergeable" });
      const sha = commit(out, [into, head], body.commit_title ?? `Merge pull request #${pr.number}`, null, u.login);
      r.refs.set(pr.base, sha);
      Object.assign(pr, { state: "closed", merged: true, mergeSha: sha, mergedHead: head });
      if (r.deleteOnMerge) {
        r.refs.delete(pr.head);
        for (const y of r.pulls) if (y.state === "open" && y.base === pr.head) y.base = pr.base;
      }
      return json(200, { sha, merged: true, message: "Pull Request successfully merged" });
    }
    if ((x = /^\/issues\/(\d+)\/comments$/.exec(rest)) && req.method === "POST") {
      const pr = r.pulls[Number(x[1]) - 1];
      if (!pr) return json(404, { message: "Not Found" });
      (pr.comments ??= []).push(body.body);
      return json(201, { body: body.body });
    }
    if ((x = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = r.pulls[Number(x[1]) - 1];
      if (!pr) return json(404, { message: "Not Found" });
      if (req.method === "PATCH") {
        if (body.base !== undefined) {
          if (!r.refs.has(body.base)) return json(422, { message: "Validation Failed", errors: [{ message: `Proposed base branch '${body.base}' was not found` }] });
          if (r.dismissStale && pr.base !== body.base) pr.reviews = pr.reviews.filter((x) => x.state !== "APPROVED");
          pr.base = body.base;
        }
        if (body.state === "open" && (!r.refs.has(pr.base) || !r.refs.has(pr.head))) return json(422, { message: "state cannot be changed. The branch has been deleted." });
        for (const k of ["title", "body", "state"] as const) if (body[k] !== undefined) pr[k] = body[k];
      }
      return json(200, pullJson(pr));
    }
    if ((x = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest))) return json(200, { check_runs: checks.get(x[1]) ?? [] });
    if (rest.startsWith("/contents/") && req.method === "PUT") {
      const path = decodeURIComponent(rest.slice("/contents/".length));
      const b = Buffer.from(body.content, "base64");
      blobs.set(blobId(b), b);
      const parent = r.refs.get(body.branch);
      const tree = new Map(parent ? commits.get(parent)!.tree : []);
      tree.set(path, { mode: "100644", sha: blobId(b) });
      const sha = commit(tree, parent ? [parent] : [], body.message, body.author ?? null, u.login);
      r.refs.set(body.branch, sha);
      return json(201, { commit: { sha } });
    }
    json(404, { message: "Not Found" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    stats,
    user(login: string, id = ++n) {
      const u = { id, login, email: `${login}@users.example` };
      users.set(login, u);
      return u;
    },
    /** The code GitHub sends the browser back with once the user approves. */
    approve(u: GhUser) {
      const c = `code_${++n}`;
      codes.set(c, u);
      return c;
    },
    setExpiresIn: (s: number) => { expiresIn = s; },
    /** Who approves when a browser comes to /login/oauth/authorize. */
    authorizeAs: (u: GhUser) => { authorizeAs = u; },
    revokeAll: () => { tokens.clear(); refreshTokens.clear(); },
    expireAccessTokens: () => { for (const t of tokens.values()) t.exp = Date.now() - 1; },
    addRepo,
    repo: (full: string) => repos.get(full)!,
    write,
    /** Renamed on GitHub (its old name is free for another repository). */
    rename(full: string, name: string) {
      const r = repos.get(full)!;
      repos.delete(full);
      r.name = name;
      repos.set(`${r.owner}/${name}`, r);
      return r;
    },
    /** A commit's check run (replacing the one before). */
    check: (sha: string, status: string, conclusion: string | null) => checks.set(sha, [{ status, conclusion }]),
    /** Make the token endpoint fail the way a wrong client secret does. */
    breakClientSecret: (on: boolean) => { badSecret = on; },
    /** The files at a branch's head (utf8). */
    files(full: string, branch = "main") {
      const r = repos.get(full)!;
      return Object.fromEntries([...commits.get(r.refs.get(branch)!)!.tree].map(([p, e]) => [p, blobs.get(e.sha)!.toString()]));
    },
    commit: (sha: string) => commits.get(sha)!,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
