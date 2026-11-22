// Source control for the open project (studio/git.ts): connect GitHub, link the app to a repository (a new one, or
// one the user has), and once linked: the branch, switching branches, pull and push. GitHub is reached only through
// this server, as the signed-in user.
import { type Ref, useImperativeHandle, useRef, useState } from "react";
import type * as API from "../../../api-types.ts";
import { gitCode, type GitFile, type GitWorkspace, type ProjectGitState } from "../../../git.ts";
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

type Load = { me: API.MeGit; status: API.GitStatus | null; repos: API.GitRepo[] | null; error?: string };

export function GitDialog({ ref, git, app, files, hydrate, deployFirst }: {
  ref: Ref<GitDialogHandle>;
  git: GitWorkspace | null;
  /** The project's app, once deployed (a repository links to an app). */
  app: string | undefined;
  files: () => Promise<GitFile[]>;
  hydrate: (files: GitFile[]) => Promise<void>;
  deployFirst: () => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<Load | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [mode, setMode] = useState<"create" | "link">("create");
  const [repoName, setRepoName] = useState("");
  const [priv, setPriv] = useState(true);
  const [picked, setPicked] = useState("");
  const [initial, setInitial] = useState<"push" | "pull">("push");
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    setError(null);
    const me = await api<API.MeGit>("/v1/me/git").catch(() => null);
    if (!me) return setLoad({ me: { provider: "github", available: false, kind: null, connected: false, login: null, status: null, installUrl: null }, status: null, repos: null });
    let status: API.GitStatus | null = null, repos: API.GitRepo[] | null = null, err: string | undefined;
    try {
      if (me.connected && me.status === "active" && git?.state && app) {
        status = await api<API.GitStatus>(`/v1/apps/${encodeURIComponent(app)}/git/status`);
        setBranch(git.state.activeBranch);
      } else if (me.connected && me.status === "active" && app) {
        repos = (await api<{ repos: API.GitRepo[] }>("/v1/git/github/repos")).repos;
        setPicked((p) => p || repos![0]?.fullName || "");
      }
    } catch (e) {
      err = errorMessage(e);
      if (gitCode(e) === "git_reauth_required") me.status = "expired";
    }
    setLoad({ me, status, repos, error: err });
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
    const r = await api<{ repo: API.AppRepo; sha: string; files?: GitFile[] }>(`/v1/apps/${encodeURIComponent(app!)}/git/connect`, json("POST", {
      owner, repo, initialSync: sync, ...(sync === "push" ? { files: await files(), message: `Add ${app} from Cresslet` } : {}),
    }));
    if (r.files) await hydrate(r.files);
    const st: ProjectGitState = {
      provider: "github", owner: r.repo.owner, repo: r.repo.name, url: r.repo.url, defaultBranch: r.repo.defaultBranch,
      activeBranch: r.repo.defaultBranch, baseSha: r.sha, headSha: r.sha, dirty: false,
    };
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
            <p className="muted">Deploy this project once to give it an app address; then link that app to a repository.</p>
            <div className="row start"><button className="btn primary" type="button" onClick={() => { dlg.current?.close(); deployFirst(); }}><Icon name="rocket" />Deploy</button></div>
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
                const r = await git!.sync(message.trim() || `Update ${app}`);
                setMessage("");
                return r.changed ? `Pushed to ${s.activeBranch}` : "Nothing to push";
              })}>Push</button>
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
            <div className="modal-foot row">
              <button className="btn danger sm" type="button" id="git-unlink" disabled={!!busy} onClick={() => {
                if (!confirm(`Unlink ${app} from ${s.owner}/${s.repo}? The repository is left as it is.`)) return;
                void run("Unlinking…", async () => {
                  await api(`/v1/apps/${encodeURIComponent(app)}/git`, { method: "DELETE" });
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
                  <label className="check"><input type="radio" name="git-initial" checked={initial === "push"} onChange={() => setInitial("push")} /> Push this workspace to it</label>
                  <label className="check"><input type="radio" name="git-initial" checked={initial === "pull"} onChange={() => setInitial("pull")} /> Pull its files into this workspace (replaces them)</label>
                </fieldset>
              </>
            )}
            {me!.installUrl ? <p className="muted small">Missing a repository? <ExtLink href={me!.installUrl}>Choose which repositories Cresslet can reach</ExtLink>.</p> : null}
            <div className="row">
              <button className="btn primary" type="submit" id="git-link" disabled={!!busy}>{mode === "create" ? "Create and push" : "Link"}</button>
            </div>
          </form>
        )}
        {load?.error ? <p className="error small" role="alert">{load.error}</p> : null}
        {error ? (
          <div className="error small" role="alert" id="git-error">
            <p>{error.text}</p>
            {error.code === "git_reauth_required" ? <button className="btn sm" type="button" onClick={() => void connectGithub()}>Reconnect GitHub</button> : null}
            {error.code === "conflict" && s ? (
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
