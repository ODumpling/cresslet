// First deploy from the studio: the new app's address, generated and editable (GET /v1/names).
import { type Ref, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "../../ui/icons.tsx";
import { SlugField, useSlug } from "../../ui/SlugField.tsx";

export interface DeployDialogHandle {
  /**
   * Asks for a new app's address (a generated one to start with). Resolves to the name, or null if cancelled.
   * `reserve`: only the address (source control links a repository before the first deploy).
   */
  ask(opts?: { reserve?: boolean }): Promise<string | null>;
}

export function DeployDialog({ ref }: { ref: Ref<DeployDialogHandle> }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const slug = useSlug("app");
  const [checking, setChecking] = useState(false);
  const [reserving, setReserving] = useState(false);
  // The ask in progress: its number (a later ask supersedes it), what was picked, and how to answer it.
  const asking = useRef({ n: 0, picked: null as string | null, resolve: null as ((name: string | null) => void) | null });

  useImperativeHandle(ref, () => ({
    ask(opts) {
      setReserving(!!opts?.reserve);
      const a = asking.current;
      a.n++;
      a.resolve?.(null);
      return new Promise<string | null>((resolve) => {
        a.picked = null;
        a.resolve = resolve;
        setChecking(false); // a cancelled ask may have left it disabled mid-check
        const d = dlg.current!; // mounted
        d.showModal();
        void slug.suggest().then(() => d.open && slug.field.input.current?.select());
      });
    },
  }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = asking.current, ask = a.n, d = dlg.current!; // mounted
    setChecking(true);
    const name = await slug.value().catch(() => null);
    if (ask !== a.n || !d.open) return; // cancelled while checking (or asked again since)
    setChecking(false);
    if (!name) return slug.field.input.current?.focus();
    a.picked = name;
    // Answered now, not on "close" (dispatched later): the deploy starts while focus is back on Deploy.
    const resolve = a.resolve;
    a.resolve = null;
    d.close();
    resolve?.(name);
  }

  return (
    <dialog className="modal" id="deploy-dialog" ref={dlg} aria-labelledby="deploy-dialog-title" aria-describedby="deploy-dialog-desc"
      onClose={() => {
        const a = asking.current;
        if (dlg.current?.open) return; // an earlier close's event (it's dispatched later), delivered after this one opened
        const resolve = a.resolve;
        a.resolve = null;
        resolve?.(a.picked);
      }}>
      <form className="form" id="deploy-form" method="dialog" onSubmit={(e) => void submit(e)}>
        <div>
          <h2 id="deploy-dialog-title">{reserving ? "Choose the app's address" : "Deploy a new app"}</h2>
          <p className="muted" id="deploy-dialog-desc">{reserving
            ? "The app gets this address; nothing goes live until you deploy. Keep the one we picked or choose your own."
            : "It goes live at this address. Keep the one we picked or choose your own; it stays the same for every later deploy."}</p>
        </div>
        <SlugField slug={slug} id="deploy-name" hint="Lowercase letters, numbers and single dashes, up to 40." />
        <div className="row">
          <button className="btn" type="button" id="deploy-cancel" onClick={() => dlg.current?.close()}>Cancel</button>
          <button className="btn primary" type="submit" id="deploy-confirm" disabled={checking}>{reserving ? <><Icon name="globe" />Reserve</> : <><Icon name="rocket" />Deploy</>}</button>
        </div>
      </form>
    </dialog>
  );
}
