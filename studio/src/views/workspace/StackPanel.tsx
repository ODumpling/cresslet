// The app's stack of changes (server/stack.ts), on the AI builder's Shipline rail: each builder turn that changed files is a
// change on a branch of its own, oldest first (under "Not live yet": the default branch is what deploys). The change the workspace is on is
// marked, and a branch that moved or is gone on GitHub says so. Any change below the top can be gone back to (the
// ones above are set aside, shown struck through), and set-aside changes restored. On a default branch that needs pull
// requests (protected), the stack lands from the bottom up: Land next on the bottom change, disabled with the reason
// while GitHub wouldn't merge its pull request yet.
import { landBlocked, type ProjectGitState, type PullRequest, type Stack, type StackChange } from "../../../git.ts";
import { ExtLink } from "../../ui/icons.tsx";

export function StackPanel({ stack, state, busy, pulls = {}, onContinue, onBack, onRestore, onSubmit, onOutside, onLand, onLandNext, onUpdate, onUpdateStack, onFold, onUndo }: {
  stack: Stack;
  state: ProjectGitState;
  busy: boolean;
  /** Its changes' pull requests, by change id (review and checks). */
  pulls?: Record<string, PullRequest>;
  /** Opens or updates a pull request per change. */
  onSubmit: () => void;
  /** Undoes a change, keeping the later ones (the top: going back instead). */
  onUndo: (change: StackChange) => void;
  /** Folds a change into the one below it. */
  onFold: (change: StackChange) => void;
  /** Lands a change and the ones below it into the default branch. */
  onLand: (change: StackChange) => void;
  /** Lands the bottom change through its pull request (a protected default branch). */
  onLandNext: (change: StackChange) => void;
  /** Merges the default branch into the bottom change (its pull request must be up to date). */
  onUpdate: (change: StackChange) => void;
  /** Brings the default branch's new commits into every change, from the bottom up. */
  onUpdateStack: () => void;
  /** A change pushed to on GitHub: pulled in as the stack's top, or carried on from as a branch of its own. */
  onOutside: (how: "pull-in" | "carry-on", change: StackChange) => void;
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
  const bottom = stack.changes[0];
  // A default branch that needs pull requests: landed from the bottom, one at a time.
  const guarded = !!stack.guarded;
  const blocked = guarded ? landBlocked(bottom, pulls[bottom.id], state.defaultBranch) : null;
  const tree = (branch: string) => `${state.url}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const row = (c: StackChange, aside: boolean) => {
    const here = !aside && c.branch === state.activeBranch;
    return (
      <li key={c.id} className="stack-row" data-here={here ? "" : undefined} data-aside={aside ? "" : undefined} data-github={c.github}>
        <span className="stack-dot" aria-hidden="true">{c.position}</span>
        <div className="stack-body">
          <span className="stack-title">
            <span>{`${c.position} · ${c.title}`}</span>
            {aside ? <span className="sr-only"> (set aside)</span> : null}
            {here ? <span className="pill" data-s="here">workspace</span> : null}
            {c.github !== "ok" ? <span className="pill" data-s="warn">{c.github === "gone" ? "gone on GitHub" : "moved on GitHub"}</span> : null}
            {!aside && (on || (guarded && c === bottom)) ? (
              <span className="stack-actions">
                {on && c !== top ? <button className="btn sm" type="button" disabled={busy} onClick={() => onBack(c)} aria-label={`Go back to change ${c.position}, ${c.title}`}>Go back</button> : null}
                {on && state.activeBranch === top.branch && (c !== top || stack.changes.length > 1) ? (
                  <button className="btn sm" type="button" disabled={busy} onClick={() => onUndo(c)} aria-label={`Undo change ${c.position}, ${c.title}`}>Undo</button>
                ) : null}
                {c !== stack.changes[0] && state.activeBranch === top.branch ? (
                  <button className="btn sm" type="button" disabled={busy} onClick={() => onFold(c)}
                    aria-label={`Fold change ${c.position}, ${c.title}, into change ${stack.changes[stack.changes.indexOf(c) - 1].position}`}>Fold</button>
                ) : null}
                {state.activeBranch === top.branch && !guarded ? <button className="btn sm" type="button" disabled={busy} onClick={() => onLand(c)}
                  aria-label={c === stack.changes[0] ? `Land change ${c.position} in ${state.defaultBranch}` : `Land changes ${stack.changes[0].position} to ${c.position} in ${state.defaultBranch}`}>Land</button> : null}
                {guarded && c === bottom && pulls[c.id]?.mergeable === "behind" ? (
                  <button className="btn sm" type="button" disabled={busy} onClick={() => onUpdate(c)} aria-label={`Update change ${c.position} with ${state.defaultBranch}`}>Update</button>
                ) : null}
                {guarded && c === bottom ? (
                  <button className="btn sm" type="button" disabled={busy || !!blocked} onClick={() => onLandNext(c)} aria-describedby={blocked ? `land-next-why-${c.id}` : undefined}
                    aria-label={`Land change ${c.position} in ${state.defaultBranch} through its pull request`}>Land next</button>
                ) : null}
              </span>
            ) : null}
          </span>
          <ExtLink className="ext stack-branch mono" href={tree(c.branch)}>{c.branch}</ExtLink>
          {!aside && c.github === "moved" ? (
            <span className="stack-outside small">
              <span className="muted">Changed on GitHub since.</span>
              <button className="btn sm" type="button" disabled={busy} onClick={() => onOutside("pull-in", c)} aria-label={`Pull in change ${c.position} as GitHub has it, as the top of the stack`}>Pull it in</button>
              <button className="btn sm" type="button" disabled={busy} onClick={() => onOutside("carry-on", c)} aria-label={`Carry on from change ${c.position} as a branch of its own`}>Carry on from it</button>
            </span>
          ) : null}
          {guarded && !aside && c === bottom && blocked ? <span className="stack-why small muted" id={`land-next-why-${c.id}`}>{`Can't land yet: ${blocked}.`}</span> : null}
          {!aside && c.pull ? (
            <span className="stack-pull small">
              <ExtLink href={`${state.url}/pull/${c.pull}`}>{`Pull request #${c.pull}`}</ExtLink>
              {pulls[c.id] ? <span className="muted">{` · ${pulls[c.id].review.replace("_", " ")} · checks ${pulls[c.id].checks}`}</span> : null}
            </span>
          ) : null}
        </div>
      </li>
    );
  };
  const aside = stack.setAside ?? [];
  const pulled = stack.changes.some((c) => c.pull);
  // On the Shipline rail (Builder.tsx), under "Not live yet": oldest first, as they were made; set-aside ones last.
  return (
    <div className="stack-panel" id="stack-panel" role="group" aria-label={`Stack ${stack.name}`}>
      <div className="stack-bar small">
        <span className="stack-head">{`${n} ${n === 1 ? "change" : "changes"} on `}<span className="mono">{state.defaultBranch}</span></span>
        {on ? (
          <button className="btn sm" type="button" id="stack-submit" disabled={busy} onClick={onSubmit}
            title={pulled ? "Pull requests: one per change, each on the one below." : "Review it on GitHub as a chain of pull requests, one per change."}>
            {pulled ? "Update pull requests" : "Submit stack"}
          </button>
        ) : null}
      </div>
      {!on ? (
        <div className="stack-note small">
          <span className="muted">{`This workspace is on ${state.activeBranch}, not on this stack.`}</span>
          <button className="btn sm" type="button" id="stack-continue" disabled={busy} onClick={() => onContinue(top.branch)}>Continue on it</button>
        </div>
      ) : null}
      {on && stack.behind ? (
        <div className="stack-note small">
          <span className="muted">{`${state.defaultBranch} has commits this stack doesn't (pushed or landed since). Update stack merges them into each change, from the bottom up.`}</span>
          <button className="btn sm" type="button" id="stack-update" disabled={busy} onClick={onUpdateStack}>Update stack</button>
        </div>
      ) : null}
      {on && guarded ? (
        <div className="stack-note small">
          <span className="muted">{`${state.defaultBranch} needs pull requests, so changes land one at a time from the bottom (Land next).${n > 1 ? " Reviewers: approve the bottom change first. An approval of a change above it may not carry over once it becomes the bottom." : ""}`}</span>
        </div>
      ) : null}
      {aside.length ? (
        <div className="stack-note small">
          <span className="muted">{`${aside.length} ${aside.length === 1 ? "change" : "changes"} set aside (kept on GitHub). Anything committed on ${top.position} drops ${aside.length === 1 ? "it" : "them"}.`}</span>
          <button className="btn sm" type="button" id="stack-restore" disabled={busy} onClick={onRestore}>Restore</button>
        </div>
      ) : null}
      <ol className="stack" aria-label={`Changes of ${stack.name}, oldest first`}>
        {stack.changes.map((c) => row(c, false))}
        {aside.map((c) => row(c, true))}
      </ol>
    </div>
  );
}
