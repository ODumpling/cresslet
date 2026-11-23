// ⌘K: one box to run any of the workspace's actions or open a file. A modal <dialog> (focus stays in it, Escape
// closes it and focus goes back where it was); the list is a listbox the field drives (arrows, Enter).
import { type Ref, useImperativeHandle, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Icon } from "../../ui/icons.tsx";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: string;
  /** Its shortcut, shown. */
  keys?: string;
  run: () => void;
}

export interface PaletteHandle {
  open(): void;
  toggle(): void;
}

export function CommandPalette({ commands, ref }: { commands: () => Command[]; ref: Ref<PaletteHandle> }) {
  const dialog = useRef<HTMLDialogElement>(null), field = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [list, setList] = useState<Command[]>([]);
  const open = () => {
    const d = dialog.current;
    if (!d || d.open) return;
    flushSync(() => {
      setList(commands());
      setQ("");
      setAt(0);
    });
    d.showModal();
    field.current?.focus();
  };
  useImperativeHandle(ref, () => ({
    open,
    toggle: () => (dialog.current?.open ? dialog.current.close() : open()),
  }));

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = list.filter((c) => words.every((w) => `${c.group} ${c.label}`.toLowerCase().includes(w)));
    return hits.slice(0, 60);
  }, [q, list]);
  const pick = (c: Command | undefined) => {
    if (!c) return;
    dialog.current?.close();
    c.run();
  };

  let group = "";
  return (
    <dialog className="palette" id="palette" ref={dialog} aria-label="Commands" onClick={(e) => e.target === dialog.current && dialog.current.close()}>
      <div className="palette-in">
        <Icon name="search" />
        <input ref={field} id="palette-input" type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
          aria-activedescendant={shown[at] ? `cmd-${shown[at].id}` : undefined} placeholder="Search actions and files…" autoComplete="off" spellCheck={false}
          value={q} onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            const n = shown.length;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (n) setAt((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(shown[at]);
            }
          }} />
        <kbd>Esc</kbd>
      </div>
      <ul className="palette-list" id="palette-list" role="listbox" aria-label="Commands">
        {shown.map((c, i) => {
          const head = c.group !== group ? (group = c.group) : null;
          return [
            head ? <li key={`g-${head}`} className="palette-group" role="presentation">{head}</li> : null,
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === at} className="palette-item"
              onMouseMove={() => i !== at && setAt(i)} onClick={() => pick(c)}>
              <Icon name={c.icon} /><span className="palette-label">{c.label}</span>{c.keys ? <kbd>{c.keys}</kbd> : null}
            </li>,
          ];
        })}
        {!shown.length ? <li className="palette-none" role="presentation">Nothing matches.</li> : null}
      </ul>
    </dialog>
  );
}
