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

/** Decide what `ensureNotPasswordField` (keyboard.ts) should do with a
 * `Runtime.evaluate` probe result. Pure/chrome-free so the decision is
 * unit-testable, mirroring `classifyAttachError`/`classifyWaitError`.
 *
 * SECURITY.md documents a blind spot: a page with a throwing getter for
 * `type`/`shadowRoot` makes the `findActiveField` probe throw, so
 * `result.value` never arrives — treating that as "not a password field"
 * would silently let the gate pass. Fail closed instead: a probe exception
 * or a missing value blocks the keystroke with a distinct code from
 * `password_field` (we don't actually know it IS a password field, just
 * that we couldn't rule it out), so the recovery hint can't misleadingly
 * suggest `allowPassword=true`. */
export function classifyPasswordProbe(
  result: { value?: { tag: string; type: string } },
  hadException: boolean,
):
  | { blocked: false }
  | { blocked: true; code: 'password_field' | 'focus_probe_failed'; reason: string } {
  if (hadException || result.value === undefined) {
    return {
      blocked: true,
      code: 'focus_probe_failed',
      reason:
        "could not verify the focused field is safe to type into (the page's type/shadowRoot " +
        'accessor threw or returned nothing) — use fill instead (reads the DOM attribute ' +
        'directly, unaffected by in-page getters), or inspect the field with snapshot/get_state',
    };
  }
  if (result.value.tag === 'INPUT' && result.value.type === 'password') {
    return {
      blocked: true,
      code: 'password_field',
      reason: 'focus is on <input type=password>; pass allowPassword=true to override',
    };
  }
  return { blocked: false };
}
