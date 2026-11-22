// The toast: one message at a time, callable from anywhere (`toast(...)`), shown by <Toast /> in the layout.
// Its body is a live region that stays in the page (one that appears with its message may not be announced). It
// stays open while hovered or focused (WCAG 2.2.1), Escape or × dismisses it, and it never covers the focused control
// (WCAG 2.4.11).
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { focusView } from "./focus.ts";
import { Icon } from "../ui/icons.tsx";

interface Message {
  content: ReactNode;
  ms: number;
  /** Counts messages: a new one restarts the timer even with the same text. */
  n: number;
}
let current: Message | null = null, count = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => current;

export function toast(content: ReactNode, ms = 6000) {
  current = { content, ms, n: ++count };
  emit();
}
export function closeToast() {
  if (!current) return;
  current = null;
  emit();
}

export function Toast() {
  const msg = useSyncExternalStore(subscribe, snapshot, () => null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const open = !!msg;

  // Never cover the focused control: if it's under the toast, the toast moves to the top edge; if it would be covered
  // there too (tiny viewports), it turns transparent (still announced, still reachable by Tab, which brings it back)
  // until focus moves or the page scrolls.
  useEffect(() => {
    const t = ref.current!; // mounted
    const avoid = () => {
      const a = document.activeElement;
      if (a && t.contains(a)) {
        if (t.dataset.top === "hide") t.dataset.top = "false"; // Tab into a transparent toast: show it
        return; // otherwise stay put while it's used (a click focuses × before it lands)
      }
      t.dataset.top = "false";
      if (t.dataset.open !== "true" || !a || a === document.body) return;
      const r = a.getBoundingClientRect();
      const covers = () => {
        const q = t.getBoundingClientRect();
        if (r.height > q.height * 2 || r.width > q.width) return false; // a large area (log, editor) can't be hidden by it
        return r.bottom > q.top && r.top < q.bottom && r.right > q.left && r.left < q.right;
      };
      if (!covers()) return;
      t.dataset.top = "true";
      if (covers()) t.dataset.top = "hide";
    };
    let frame = 0;
    const later = () => void (frame ||= requestAnimationFrame(() => {
      frame = 0;
      avoid();
    }));
    // Capture phase: xterm and CodeMirror stop Escape; the event still reaches them.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && t.dataset.open === "true" && dismiss();
    addEventListener("focusin", avoid);
    addEventListener("scroll", later, { capture: true, passive: true }); // scrolling can move focus under it
    addEventListener("resize", later);
    addEventListener("keydown", esc, true);
    if (open) avoid();
    return () => {
      removeEventListener("focusin", avoid);
      removeEventListener("scroll", later, { capture: true });
      removeEventListener("resize", later);
      removeEventListener("keydown", esc, true);
      cancelAnimationFrame(frame);
    };
  }, [open, msg?.n]);

  const arm = () => {
    clearTimeout(timer.current);
    const t = ref.current;
    if (t && current && !t.matches(":hover") && !t.contains(document.activeElement)) timer.current = setTimeout(dismiss, current.ms);
  };
  useEffect(() => {
    arm();
    return () => clearTimeout(timer.current);
  }, [msg?.n]);

  function dismiss() {
    clearTimeout(timer.current);
    const hadFocus = !!ref.current?.contains(document.activeElement);
    closeToast();
    if (hadFocus) setTimeout(() => focusView()); // once × is gone
  }

  return (
    <div
      className="toast"
      id="toast"
      ref={ref}
      data-open={String(open)}
      onPointerEnter={() => clearTimeout(timer.current)}
      onPointerLeave={arm}
      onFocus={() => clearTimeout(timer.current)}
      onBlur={() => setTimeout(arm)}
    >
      <div className="toast-body" id="toast-body" role="status" aria-live="polite" aria-atomic="true">{msg?.content}</div>
      <button className="icon-btn" id="toast-close" type="button" aria-label="Dismiss message" hidden={!open} onClick={dismiss}>
        <Icon name="x" />
      </button>
    </div>
  );
}
