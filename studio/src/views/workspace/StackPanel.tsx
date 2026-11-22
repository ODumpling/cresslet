// The app's stack of changes (server/stack.ts), above the AI builder's chat: each builder turn that changed files is a
// change on a branch of its own, newest on top, the default branch at the bottom. The change the workspace is on is
// marked, and a branch that moved or is gone on GitHub says so. Any change below the top can be gone back to (the
// ones above are set aside, shown struck through), and set-aside changes restored.
import type { ProjectGitState, Stack, StackChange } from "../../../git.ts";
import { ExtLink } from "../../ui/icons.tsx";

export function StackPanel({ stack, state, busy, onContinue, onBack, onRestore }: {
  stack: Stack;
  state: ProjectGitState;
  busy: boolean;
  /** Loads the stack's top change into the workspace (it's on another branch). */
  onContinue: (branch: string) => void;
  /** Goes back to a change (the ones above it set aside). */
  onBack: (change: StackChange) => void;
  /** Puts the set-aside changes back. */
  onRestore: () => void;
}) {
  const top = stack.changes.at(-1);
  if (!top) return null;
  const on = stack.changes.some((c) => c.branch === state.activeBranch);
  const n = stack.changes.length;
  const tree = (branch: string) => `${state.url}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const row = (c: StackChange, aside: boolean) => {
    const here = !aside && c.branch === state.activeBranch;
    return (
      <li key={c.id} className="stack-row" data-here={here ? "" : undefined} data-aside={aside ? "" : undefined} data-github={c.github}>
        <span className="stack-dot" aria-hidden="true" />
        <div className="stack-body">
          <span className="stack-title">
            <span>{`${c.position} · ${c.title}`}</span>
            {aside ? <span className="sr-only"> (set aside)</span> : null}
            {here ? <span className="pill" data-s="here">workspace</span> : null}
            {c.github !== "ok" ? <span className="pill" data-s="warn">{c.github === "gone" ? "gone on GitHub" : "moved on GitHub"}</span> : null}
            {!aside && c !== top ? (
              <button className="btn sm stack-back" type="button" disabled={busy} onClick={() => onBack(c)} aria-label={`Go back to change ${c.position}, ${c.title}`}>Go back</button>
            ) : null}
          </span>
          <ExtLink className="ext stack-branch mono" href={tree(c.branch)}>{c.branch}</ExtLink>
        </div>
      </li>
    );
  };
  const aside = stack.setAside ?? [];
  return (
    <details className="stack-panel" id="stack-panel" open>
      <summary><span className="stack-head">Stack</span><span className="muted small">{` ${stack.name} · ${n} ${n === 1 ? "change" : "changes"}`}</span></summary>
      {!on ? (
        <div className="stack-note small">
          <span className="muted">{`This workspace is on ${state.activeBranch}, not on this stack.`}</span>
          <button className="btn sm" type="button" id="stack-continue" disabled={busy} onClick={() => onContinue(top.branch)}>Continue on it</button>
        </div>
      ) : null}
      {aside.length ? (
        <div className="stack-note small">
          <span className="muted">{`${aside.length} ${aside.length === 1 ? "change" : "changes"} set aside (kept on GitHub). The next request starts a new change on ${top.position} and drops ${aside.length === 1 ? "it" : "them"}.`}</span>
          <button className="btn sm" type="button" id="stack-restore" disabled={busy} onClick={onRestore}>Restore</button>
        </div>
      ) : null}
      <ol className="stack" aria-label={`Changes of ${stack.name}, newest first`}>
        {[...aside].reverse().map((c) => row(c, true))}
        {[...stack.changes].reverse().map((c) => row(c, false))}
        <li className="stack-row" data-base="">
          <span className="stack-dot" aria-hidden="true" />
          <div className="stack-body">
            <span className="stack-title"><span>{state.defaultBranch}</span></span>
            <span className="muted small">stays as deployed until you deploy</span>
          </div>
        </li>
      </ol>
    </details>
  );
}
