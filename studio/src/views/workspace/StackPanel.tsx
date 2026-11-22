// The app's stack of changes (server/stack.ts), above the AI builder's chat: each builder turn that changed files is a
// change on a branch of its own, newest on top, the default branch at the bottom. The change the workspace is on is
// marked, and a branch that moved or is gone on GitHub says so.
import type { ProjectGitState, Stack } from "../../../git.ts";
import { ExtLink } from "../../ui/icons.tsx";

export function StackPanel({ stack, state, busy, onContinue }: {
  stack: Stack;
  state: ProjectGitState;
  busy: boolean;
  /** Loads the stack's top change into the workspace (it's on another branch). */
  onContinue: (branch: string) => void;
}) {
  const top = stack.changes.at(-1);
  if (!top) return null;
  const on = stack.changes.some((c) => c.branch === state.activeBranch);
  const n = stack.changes.length;
  const tree = (branch: string) => `${state.url}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
  return (
    <details className="stack-panel" id="stack-panel" open>
      <summary><span className="stack-head">Stack</span><span className="muted small">{` ${stack.name} · ${n} ${n === 1 ? "change" : "changes"}`}</span></summary>
      {!on ? (
        <div className="stack-note small">
          <span className="muted">{`This workspace is on ${state.activeBranch}, not on this stack.`}</span>
          <button className="btn sm" type="button" id="stack-continue" disabled={busy} onClick={() => onContinue(top.branch)}>Continue on it</button>
        </div>
      ) : null}
      <ol className="stack" aria-label={`Changes of ${stack.name}, newest first`}>
        {[...stack.changes].reverse().map((c) => {
          const here = c.branch === state.activeBranch;
          return (
            <li key={c.id} className="stack-row" data-here={here ? "" : undefined} data-github={c.github}>
              <span className="stack-dot" aria-hidden="true" />
              <div className="stack-body">
                <span className="stack-title">
                  <span>{`${c.position} · ${c.title}`}</span>
                  {here ? <span className="pill" data-s="here">workspace</span> : null}
                  {c.github !== "ok" ? <span className="pill" data-s="warn">{c.github === "gone" ? "gone on GitHub" : "moved on GitHub"}</span> : null}
                </span>
                <ExtLink className="ext stack-branch mono" href={tree(c.branch)}>{c.branch}</ExtLink>
              </div>
            </li>
          );
        })}
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
