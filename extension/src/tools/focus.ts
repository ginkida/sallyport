/** Pure focus-traversal for the keystroke password gate.
 *
 * `keyboard.ts` serialises `findActiveField` into a page probe via
 * `Function.prototype.toString` (it runs inside the page through
 * `Runtime.evaluate`). It lives here, free of any `chrome.*` import, so it
 * can be unit-tested directly — `keyboard.ts` itself pulls in `cdp.ts`,
 * which registers chrome listeners at import time and can't load under
 * vitest.
 *
 * The function descends `document.activeElement` through OPEN shadow roots
 * to the deepest focused node — `document.activeElement` otherwise retargets
 * to the shadow *host*, hiding a focused `<input type=password>` inside a
 * custom element. CLOSED shadow roots (`shadowRoot === null` to page script)
 * and iframes are unreachable from here and are documented blind spots in
 * SECURITY.md.
 *
 * MUST stay self-contained — no imports, no closure references — so
 * `toString()` serialisation yields a runnable standalone page expression. */
export type FocusNode = {
  tagName?: string;
  type?: unknown;
  shadowRoot?: { activeElement?: FocusNode | null } | null;
} | null;

export function findActiveField(root: { activeElement?: FocusNode }): {
  tag: string;
  type: string;
} {
  let el: FocusNode = root.activeElement || null;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return {
    tag: el && el.tagName ? el.tagName : '',
    type: el && el.type ? String(el.type).toLowerCase() : '',
  };
}
