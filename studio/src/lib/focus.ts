// Focus after navigation and after a re-render (screen reader and keyboard users keep their place).

/** Moves focus to the visible view's heading (after navigation, so screen readers hear where they are). */
export function focusView({ scroll = false } = {}) {
  const h = document.querySelector<HTMLElement>("main:not([hidden]) h1");
  h?.focus({ preventScroll: true });
  if (scroll) h?.scrollIntoView({ block: "nearest" });
}

let navigatedAt = 0;
/** In-app navigation (the layout): the new view's heading gets focus once it's in the page. */
export function navigated() {
  navigatedAt = Date.now();
  requestAnimationFrame(() => focusView());
}
/**
 * A view that appears only once something loaded (after the navigation's focus move ran): if that navigation was just
 * now and focus fell back to the page, it goes to this view's heading. The first page load keeps the browser's focus.
 */
export function viewShown() {
  const a = document.activeElement;
  if (Date.now() - navigatedAt < 5000 && (!a || a === document.body)) focusView();
}

// The last focused control, as a selector that still finds it after a re-render rebuilt it.
// (Per-item controls get unique ids, e.g. revoke-<token id>: labels like "Revoke Studio (GitHub login)" repeat.)
let lastFocusKey: string | null = null, lastFocusEl: Element | null = null;
if (typeof window !== "undefined") {
  addEventListener("focusin", (e) => {
    const t = e.target as Element, label = t.getAttribute?.("aria-label"); // focusin targets are elements
    lastFocusEl = t;
    lastFocusKey = t.id ? `#${CSS.escape(t.id)}` : label ? `[aria-label="${CSS.escape(label)}"]` : null;
  });
}

/**
 * After a re-render removed the focused control (call it once the new render is in the page: flushSync): focus its
 * rebuilt twin if there is one, else `target`, else the view's heading. Does nothing if focus is still on a control
 * in the page (the user moved it meanwhile).
 */
export function refocus(target?: HTMLElement | null) {
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  // only when the last focused control was removed (a click in Safari/Firefox doesn't focus buttons, so the
  // last focusin may be an older control that's still here)
  const twin = lastFocusEl && !lastFocusEl.isConnected && lastFocusKey && document.querySelector<HTMLElement>(`main:not([hidden]) ${lastFocusKey}`);
  if (twin) twin.focus();
  else if (target) target.focus();
  else focusView();
}
/** `refocus` on the element with this id (if it's there). */
export const refocusId = (id?: string) => refocus(id ? document.getElementById(id) : null);
