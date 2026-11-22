// Source control for the open project (studio/git.ts): connect GitHub, link the app to a repository (a new one, or
// one the user has), and once linked: the branch, switching branches, pull and push. GitHub is reached only through
// this server, as the signed-in user.
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import type * as API from "../../../api-types.ts";
import { gitCode, type GitFile, type GitWorkspace, type ProjectGitState, type PullRequest } from "../../../git.ts";
import { api, errorMessage, json } from "../../lib/api.ts";
import { toast } from "../../lib/toast.tsx";
import { ExtLink, Icon } from "../../ui/icons.tsx";

export interface GitDialogHandle {
  open(): void;
}

/** Starts connecting GitHub: the browser goes to GitHub and comes back to `returnTo`. */
export async function connectGithub(returnTo = location.pathname) {
  const { url } = await api<{ url: string }>("/v1/git/github/connect", json("POST", { returnTo }));
  location.assign(url);
}

type Load = { me: API.MeGit; status: API.GitStatus | null; repos: API.GitRepo[] | null; linked: API.AppRepo | null; pull?: PullRequest | null; error?: string };

export function GitDialog({ ref, git, app, files, hydrate, reserve, onPull = () => {} }: {
  ref: Ref<GitDialogHandle>;
  git: GitWorkspace | null;
  /** The project's app, once deployed (a repository links to an app). */
  app: string | undefined;
  files: () => Promise<GitFile[]>;
  hydrate: (files: GitFile[]) => Promise<void>;
  /** Picks and reserves the app's address (nothing deployed); resolves to its name, or null if cancelled. */
  reserve: () => Promise<string | null>;
  /** A pull request was opened here (the workspace's topbar shows it). */
  onPull?: () => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<Load | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [mode, setMode] = useState<"create" | "link">("create");
  const [repoName, setRepoName] = useState("");
  const [priv, setPriv] = useState(true);
  const [picked, setPicked] = useState("");
  const [initial, setInitial] = useState<"push" | "pull" | null>(null);
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("");

  // A new repository is named after the app (also once one was just reserved).
  useEffect(() => setRepoName((n) => n || (app ?? "")), [app]);
  // The app as of now (a reservation sets it before this dialog renders again).
  const appRef = useRef(app);
  if (app) appRef.current = app;

  async function refresh() {
    const app = appRef.current;
    setError(null);
    const me = await api<API.MeGit>("/v1/me/git").catch(() => null);
    if (!me) return setLoad({ me: { provider: "github", available: false, kind: null, connected: false, login: null, status: null, installUrl: null }, status: null, repos: null, linked: null });
    let status: API.GitStatus | null = null, repos: API.GitRepo[] | null = null, linked: API.AppRepo | null = null, err: string | undefined;
    let pull: PullRequest | null | undefined;
    try {
      if (me.connected && me.status === "active" && git?.state && app) {
        try {
          status = await api<API.GitStatus>(`/v1/apps/${encodeURIComponent(app)}/git/status`);
          const st = git.state;
          setBranch(status.branches.some((b) => b.name === st.activeBranch) ? st.activeBranch : status.defaultBranch);
          if (st.activeBranch !== st.defaultBranch) pull = await git.pullRequest().catch(() => undefined);
        } catch (e) {
          // Unlinked elsewhere (another browser, the CLI): so is this workspace.
          if (gitCode(e) !== "git_not_linked") throw e;
          await git.attach(undefined);
        }
      }
      if (me.connected && me.status === "active" && app && !git?.state) {
        // Linked elsewhere, not here: offered to load, never pushed over.
        linked = (await api<API.AppDetail>(`/v1/apps/${encodeURIComponent(app)}`)).repo ?? null;
        if (!linked) {
          repos = (await api<{ repos: API.GitRepo[] }>("/v1/git/github/repos")).repos;
          // Kept only while still listed (access revoked, or renamed, since): else the select shows one and Link sends another.
          setPicked((p) => (repos!.some((r) => r.fullName === p) ? p : repos![0]?.fullName || ""));
        }
      }
    } catch (e) {
      err = errorMessage(e);
      if (gitCode(e) === "git_reauth_required") me.status = "expired";
    }
    setLoad({ me, status, repos, linked, pull, error: err });
  }

  useImperativeHandle(ref, () => ({
    open() {
      setLoad(null);
      setRepoName(app ?? "");
      setMessage("");
      dlg.current!.showModal(); // mounted
      void refresh();
    },
  }));

  /** Runs one action, showing what it does and what went wrong (the dialog stays open on errors). */
  async function run(label: string, fn: () => Promise<void | string>) {
    setBusy(label);
    setError(null);
    try {
      const done = await fn();
      if (done) toast(done);
      await refresh();
    } catch (e) {
      setError({ text: errorMessage(e), code: gitCode(e) });
    } finally {
      setBusy("");
    }
  }

  const link = () => run(mode === "create" ? "Creating the repository…" : "Linking…", async () => {
    let owner: string, repo: string;
    if (mode === "create") {
      const r = await api<{ repo: API.GitRepo }>("/v1/git/github/repos", json("POST", { name: repoName.trim(), private: priv }));
      [owner, repo] = [r.repo.owner, r.repo.name];
    } else {
      [owner, repo] = picked.split("/") as [string, string];
    }
    const sync = mode === "create" ? "push" : initial;
    if (!sync) throw new Error("choose whether this workspace or the repository's files come first");
    const rev = git!.revision; // before the snapshot: a change after it is one the repository doesn't have
    const r = await api<{ repo: API.AppRepo; sha: string; files?: GitFile[] }>(`/v1/apps/${encodeURIComponent(app!)}/git/connect`, json("POST", {
      owner, repo, initialSync: sync, ...(sync === "push" ? { files: await files(), message: `Add ${app} from Cresslet` } : {}),
    }));
    const st: ProjectGitState = {
      provider: "github", owner: r.repo.owner, repo: r.repo.name, url: r.repo.url, defaultBranch: r.repo.defaultBranch,
      activeBranch: r.repo.defaultBranch, baseSha: r.sha, headSha: r.sha, dirty: git!.revision !== rev,
    };
    if (r.files) {
      // Edited while it linked (the AI builder, say): loading the repository's files would overwrite that. Linked
      // on the server, so the next refresh offers Load.
      if (git!.revision !== rev) throw new Error("the workspace changed while linking: nothing was overwritten, load the repository's files to continue");
      try {
        await hydrate(r.files);
      } catch (e) {
        if ((e as { filesWritten?: boolean }).filesWritten) await git!.attach(st); // its files are in: linked here too
        throw e;
      }
    }
    await git!.attach(st);
    return `Linked to ${r.repo.fullName}`;
  });

  const s = git?.state, me = load?.me, active = me?.connected && me.status === "active";
  return (
    <dialog className="modal modal-lg" id="git-dialog" ref={dlg} aria-labelledby="git-dialog-title">
      <div className="form">
        <div className="modal-head">
          <h2 id="git-dialog-title">Source control</h2>
          <button className="icon-btn" type="button" aria-label="Close" onClick={() => dlg.current?.close()}><Icon name="x" /></button>
        </div>
        {!load ? <p className="muted" role="status">Loading…</p>
        : !me!.available ? <p className="muted">Source control isn't set up on this server.</p>
        : !active ? (
          <>
            <p className="muted">{me!.status === "expired"
              ? `GitHub access for ${me!.login} expired or was revoked. Connect again to sync this project.`
              : "Connect your GitHub account to keep this project in a repository. Cresslet commits as you, and your GitHub token stays on the server."}</p>
            <div className="row start">
              <button className="btn primary" type="button" id="git-connect-github" onClick={() => void run("Opening GitHub…", () => connectGithub())}><Icon name="github" />{me!.status === "expired" ? "Reconnect GitHub" : "Connect GitHub"}</button>
            </div>
          </>
        )
        : !app ? (
          <>
            <p className="muted">A repository links to an app: pick this project's app address first. Nothing goes live until you deploy.</p>
            <div className="row start"><button className="btn primary" type="button" id="git-reserve" disabled={!!busy} onClick={() => void run("Reserving the address…", async () => {
              const name = await reserve();
              if (name) {
                appRef.current = name;
                setRepoName((n) => n || name);
              }
              return name ? `Reserved ${name}` : undefined;
            })}><Icon name="globe" />Choose an address</button></div>
          </>
        )
        : !s && load.linked ? (
          <>
            <p className="muted">{`${app} is linked to `}<ExtLink href={load.linked.url}>{load.linked.fullName}</ExtLink>{`, but this workspace isn't. Load its ${load.linked.defaultBranch} branch here to work on it (this workspace's files are replaced).`}</p>
            <div className="row start">
              <button className="btn primary" type="button" id="git-adopt" disabled={!!busy} onClick={() => {
                if (!confirm(`Replace this workspace's files with ${load.linked!.fullName} (${load.linked!.defaultBranch})?`)) return;
                void run("Loading…", async () => (await git!.adopt(load.linked!), `Loaded ${load.linked!.fullName}`));
              }}>Load {load.linked.defaultBranch}</button>
            </div>
          </>
        )
        : s ? (
          <>
            <dl className="kv">
              <dt>Repository</dt><dd><ExtLink href={s.url} id="git-repo-link">{`${s.owner}/${s.repo}`}</ExtLink></dd>
              <dt>Branch</dt><dd id="git-branch">{s.activeBranch}{s.dirty ? " (changes not pushed)" : ""}</dd>
              <dt>Commit</dt><dd className="mono"><ExtLink href={`${s.url}/commit/${s.headSha}`}>{s.headSha.slice(0, 7)}</ExtLink></dd>
            </dl>
            <div className="field">
              <label htmlFor="git-message">Commit message</label>
              <input id="git-message" className="input" value={message} placeholder={`Update ${app}`} onChange={(e) => setMessage(e.target.value)} />
            </div>
            <div className="row start">
              <button className="btn primary" type="button" id="git-push" disabled={!!busy} onClick={() => void run("Pushing…", async () => {
                // Changes go on a branch: the default branch takes them only through Deploy's merge.
                const b = s.activeBranch === s.defaultBranch && s.dirty ? await git!.newBranch("edit", message.trim() || "changes") : s.activeBranch;
                const r = await git!.sync(message.trim() || `Update ${app}`);
                setMessage("");
                return r.changed ? `Pushed to ${b}` : "Nothing to push";
              })}>{s.activeBranch === s.defaultBranch && s.dirty ? "Push to a new branch" : "Push"}</button>
              <button className="btn" type="button" id="git-pull" disabled={!!busy} onClick={() => {
                if (s.dirty && !confirm(`Replace this workspace's changes with ${s.activeBranch} from GitHub?`)) return;
                void run("Pulling…", async () => (await git!.pull(), `Pulled ${s.activeBranch}`));
              }}>Pull</button>
            </div>
            {load.status ? (
              <div className="field">
                <label htmlFor="git-branch-select">Switch branch</label>
                <div className="row start">
                  <select id="git-branch-select" className="input" value={branch} onChange={(e) => setBranch(e.target.value)}>
                    {load.status.branches.map((b) => <option key={b.name} value={b.name}>{b.name}{b.protected ? " (protected)" : ""}</option>)}
                  </select>
                  <button className="btn" type="button" id="git-switch" disabled={!!busy || branch === s.activeBranch} onClick={() =>
                    void run(`Switching to ${branch}…`, async () => (await git!.switchTo(branch), `On ${branch}`))}>Switch</button>
                </div>
                <p className="muted small">Changes not pushed yet are pushed to {s.activeBranch} first. Deploy merges the branch into {s.defaultBranch}.</p>
              </div>
            ) : null}
            {load.status ? (
              <label className="check small">
                <input type="checkbox" id="git-auto-submit" checked={load.status.repo.stackAutoSubmit} disabled={!!busy} onChange={(e) => {
                  const on = e.target.checked;
                  void run("Saving…", async () => {
                    await api(`/v1/apps/${encodeURIComponent(app)}/git`, json("PATCH", { stackAutoSubmit: on }));
                    return on ? "A pull request opens for each change as it's made" : "Pull requests open when you submit the stack";
                  });
                }} />
                Open a pull request for each change as it's made (otherwise: Submit stack, above the AI builder's chat)
              </label>
            ) : null}
            {s.activeBranch !== s.defaultBranch && load.pull !== undefined ? (
              <div className="field" id="git-pr">
                <strong className="small">Pull request</strong>
                {load.pull ? (
                  <p><ExtLink href={load.pull.url}>{`#${load.pull.number} ${load.pull.title}`}</ExtLink>
                    <span className="muted small">{` · review ${load.pull.review.replace("_", " ")} · checks ${load.pull.checks}`}</span></p>
                ) : (
                  <div className="row start">
                    <button className="btn sm" type="button" id="git-open-pr" disabled={!!busy} onClick={() => void run("Opening a pull request…", async () => {
                      const pr = await git!.openPullRequest();
                      onPull();
                      return `Pull request #${pr.number} opened${pr.stackErrors?.length ? `; not opened for ${pr.stackErrors.map((x) => `change ${x.position} (${x.error})`).join(", ")}` : ""}`;
                    })}>Open a pull request</button>
                    <span className="muted small">For a {s.defaultBranch} that needs reviews or checks: merge it on GitHub, then pull {s.defaultBranch} and deploy.</span>
                  </div>
                )}
              </div>
            ) : null}
            {s.conflicts?.length ? <p className="muted small" id="git-conflicts">{`Merging ${s.defaultBranch} in: resolve ${s.conflicts.join(", ")} (remove the conflict markers), then push or deploy.`}</p> : null}
            <div className="modal-foot row">
              <button className="btn danger sm" type="button" id="git-unlink" disabled={!!busy} onClick={() => {
                if (!confirm(`Unlink ${app} from ${s.owner}/${s.repo}? The repository is left as it is.`)) return;
                void run("Unlinking…", async () => {
                  await api(`/v1/apps/${encodeURIComponent(app)}/git`, { method: "DELETE" }).catch((e) => {
                    if (gitCode(e) !== "git_not_linked") throw e; // already unlinked elsewhere
                  });
                  await git!.attach(undefined);
                  return "Unlinked";
                });
              }}>Unlink repository</button>
            </div>
          </>
        ) : (
          <form className="form" id="git-link-form" onSubmit={(e) => { e.preventDefault(); void link(); }}>
            <fieldset className="field">
              <legend>Repository</legend>
              <label className="check"><input type="radio" name="git-mode" checked={mode === "create"} onChange={() => setMode("create")} /> Create a new repository</label>
              <label className="check"><input type="radio" name="git-mode" checked={mode === "link"} onChange={() => setMode("link")} disabled={!load.repos?.length} /> Link a repository you have</label>
            </fieldset>
            {mode === "create" ? (
              <>
                <div className="field">
                  <label htmlFor="git-repo-name">Name (under {me!.login})</label>
                  <input id="git-repo-name" className="input" required pattern="[\w.\-]{1,100}" value={repoName} onChange={(e) => setRepoName(e.target.value)} />
                </div>
                <label className="check"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private</label>
                <p className="muted small">This workspace's files are pushed to it (never local secrets: .env.local, .dev.vars and the like).</p>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="git-repo-pick">Repository</label>
                  <select id="git-repo-pick" className="input" value={picked} onChange={(e) => setPicked(e.target.value)}>
                    {load.repos?.map((r) => <option key={r.id} value={r.fullName}>{r.fullName}{r.private ? " (private)" : ""}</option>)}
                  </select>
                </div>
                <fieldset className="field">
                  <legend>First sync</legend>
                  <label className="check"><input type="radio" name="git-initial" checked={initial === "push"} onChange={() => setInitial("push")} /> Push this workspace to it: its default branch then holds exactly these files (others there are deleted)</label>
                  <label className="check"><input type="radio" name="git-initial" checked={initial === "pull"} onChange={() => setInitial("pull")} /> Pull its files into this workspace (replaces the files here)</label>
                </fieldset>
              </>
            )}
            {me!.installUrl ? <p className="muted small">Missing a repository? <ExtLink href={me!.installUrl}>Choose which repositories Cresslet can reach</ExtLink>.</p> : null}
            <div className="row">
              <button className="btn primary" type="submit" id="git-link" disabled={!!busy || (mode === "link" && !initial)}>{mode === "create" ? "Create and push" : "Link"}</button>
            </div>
          </form>
        )}
        {load?.error ? <p className="error small" role="alert">{load.error}</p> : null}
        {error ? (
          <div className="error small" role="alert" id="git-error">
            <p>{error.text}</p>
            {error.code === "git_reauth_required" ? <button className="btn sm" type="button" onClick={() => void connectGithub()}>Reconnect GitHub</button> : null}
            {error.code === "branch_not_found" && s ? (
              <div className="row start">
                <button className="btn sm" type="button" onClick={() => void run("Pushing to a new branch…", async () => {
                  const b = await git!.newBranch("keep", s.activeBranch);
                  await git!.sync(message.trim() || `Changes kept from ${s.activeBranch}`);
                  return `Pushed to a new branch, ${b}`;
                })}>Push to a new branch</button>
                <button className="btn sm" type="button" onClick={() => {
                  if (!confirm(`Drop this workspace's changes and load ${s.defaultBranch}?`)) return;
                  void run(`Switching to ${s.defaultBranch}…`, async () => (await git!.discardAndSwitch(s.defaultBranch), `On ${s.defaultBranch}`));
                }}>Discard changes and switch to {s.defaultBranch}</button>
              </div>
            ) : null}
            {(error.code === "conflict" || error.code === "not_on_top" || error.code === "set_aside") && s ? (
              <div className="row start">
                <button className="btn sm" type="button" onClick={() => void run("Pushing to a new branch…", async () => {
                  const b = await git!.newBranch("keep", s.activeBranch);
                  await git!.sync(message.trim() || `Changes kept from ${s.activeBranch}`);
                  return `Pushed to a new branch, ${b}`;
                })}>Push to a new branch</button>
                <button className="btn sm" type="button" onClick={() => {
                  if (!confirm(`Replace this workspace's changes with ${s.activeBranch} from GitHub?`)) return;
                  void run("Pulling…", async () => (await git!.pull(), `Pulled ${s.activeBranch}`));
                }}>Pull (discard changes here)</button>
              </div>
            ) : null}
          </div>
        ) : null}
        <p className="sr-only" role="status">{busy}</p>
        {busy ? <p className="muted small" aria-hidden="true"><span className="spinner" /> {busy}</p> : null}
      </div>
    </dialog>
  );
}
