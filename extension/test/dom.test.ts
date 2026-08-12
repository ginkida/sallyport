/**
 * `fill`'s password gate reads the target's `type` attribute from the browser
 * DOM via CDP `DOM.getAttributes` (a flat `[name, value, …]` list) rather than
 * a page-readable `this.type` getter, so a hostile page can't shadow the gate
 * with a throwing or lying accessor. `attributesIndicatePassword` is the pure
 * decision over that list; the chrome-bound read around it is exercised
 * manually / via the daemon e2e harness. These tests pin the fail-closed
 * semantics that the gate depends on.
 *
 * `dom.ts` imports `cdp.ts`, which registers `chrome.*` listeners at module
 * load, so we stub the minimal surface and import the module dynamically once
 * the stub is in place (vitest runs under node with no real `chrome`).
 */

import { beforeAll, describe, expect, it } from 'vitest';

let attributesIndicatePassword: (attrs: readonly string[] | null | undefined) => boolean;
let ensureFocusLanded: (focused: boolean | undefined) => void;
let CLICK_FN: string;
let FILL_READBACK_FN: string;
let DEEPEST_ACTIVE_ELEMENT_EXPR: string;
let classifyApplied: typeof import('../src/tools/dom.js').classifyApplied;
let capText: typeof import('../src/tools/dom.js').capText;
let parseMaxChars: typeof import('../src/tools/dom.js').parseMaxChars;
let parseOffset: typeof import('../src/tools/dom.js').parseOffset;
let click: (a: Record<string, unknown>, c?: unknown) => Promise<unknown>;

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onDetach: { addListener() {} } },
  };
  ({
    attributesIndicatePassword,
    ensureFocusLanded,
    CLICK_FN,
    click,
    FILL_READBACK_FN,
    DEEPEST_ACTIVE_ELEMENT_EXPR,
    classifyApplied,
    capText,
    parseMaxChars,
    parseOffset,
  } = (await import('../src/tools/dom.js')) as unknown as {
    attributesIndicatePassword: typeof attributesIndicatePassword;
    ensureFocusLanded: typeof ensureFocusLanded;
    CLICK_FN: string;
    click: typeof click;
    FILL_READBACK_FN: string;
    DEEPEST_ACTIVE_ELEMENT_EXPR: string;
    classifyApplied: typeof classifyApplied;
    capText: typeof capText;
    parseMaxChars: typeof parseMaxChars;
    parseOffset: typeof parseOffset;
  });
});

describe('attributesIndicatePassword', () => {
  it('flags an explicit type=password', () => {
    expect(attributesIndicatePassword(['type', 'password'])).toBe(true);
    expect(attributesIndicatePassword(['id', 'pw', 'type', 'password', 'name', 'p'])).toBe(true);
  });

  it('matches case-insensitively and trims, per HTML content-attribute rules', () => {
    expect(attributesIndicatePassword(['type', 'PASSWORD'])).toBe(true);
    expect(attributesIndicatePassword(['type', 'Password'])).toBe(true);
    expect(attributesIndicatePassword(['TYPE', 'password'])).toBe(true);
    expect(attributesIndicatePassword(['type', '  password  '])).toBe(true);
  });

  it('does not flag ordinary fields', () => {
    expect(attributesIndicatePassword(['type', 'text'])).toBe(false);
    expect(attributesIndicatePassword(['type', 'email'])).toBe(false);
    expect(attributesIndicatePassword(['placeholder', 'password'])).toBe(false);
  });

  it('treats a present-but-typeless element as ordinary (defaults to text)', () => {
    expect(attributesIndicatePassword([])).toBe(false);
    expect(attributesIndicatePassword(['id', 'x', 'class', 'y'])).toBe(false);
  });

  it('fails closed when the attribute list could not be read', () => {
    expect(attributesIndicatePassword(null)).toBe(true);
    expect(attributesIndicatePassword(undefined)).toBe(true);
  });

  it('ignores a dangling final name with no value', () => {
    // A malformed odd-length list must not throw; the trailing name is skipped.
    expect(attributesIndicatePassword(['type'])).toBe(false);
    expect(attributesIndicatePassword(['id', 'x', 'type'])).toBe(false);
  });
});

// fill's insertText paths type via CDP Input.insertText, which writes to
// document.activeElement — NOT the resolved, gate-checked node. ensureFocusLanded
// fails closed when focus() didn't land on the gate-checked node, so text can't
// be routed into a focused password field the gate never inspected (invariant #5).
describe('ensureFocusLanded', () => {
  it('passes when focus landed on the gate-checked node', () => {
    expect(() => ensureFocusLanded(true)).not.toThrow();
  });

  it('throws not_focusable when focus did not land (false or undefined)', () => {
    for (const v of [false, undefined]) {
      let code: string | undefined;
      let message = '';
      try {
        ensureFocusLanded(v);
      } catch (e) {
        code = (e as { code?: string }).code;
        message = (e as Error).message;
      }
      expect(code).toBe('not_focusable');
      expect(message).toMatch(/did not take focus/);
    }
  });
});

/**
 * The password gate's focus walk. `fill` gates the RESOLVED node up front, then
 * re-gates the node `Input.insertText` will actually reach. Two structures move
 * that node away from the resolved one, and both must be followed or the gate
 * inspects a wrapper while the write lands on a credential field.
 */
describe('DEEPEST_ACTIVE_ELEMENT_EXPR (password-gate focus walk)', () => {
  const walk = (doc: unknown) =>
    new Function('document', `return ${DEEPEST_ACTIVE_ELEMENT_EXPR};`)(doc) as {
      tagName?: string;
      name?: string;
    };

  it('descends a delegatesFocus shadow host to the control that really has focus', () => {
    const inner = { tagName: 'INPUT', name: 'inner' };
    const host = { tagName: 'X-FIELD', shadowRoot: { activeElement: inner } };
    expect(walk({ activeElement: host })).toBe(inner);
  });

  it('descends a same-origin iframe — the gate used to stop at the frame element', () => {
    // fill(selector='iframe.login') resolves to the FRAME, which is not a
    // password field, so the up-front gate passes; focus() then moves inside and
    // insertText lands on whatever is focused there. Stopping at the frame let a
    // write reach an <input type=password> the gate never inspected.
    const pw = { tagName: 'INPUT', name: 'password' };
    const frame = { tagName: 'IFRAME', contentDocument: { activeElement: pw } };
    expect(walk({ activeElement: frame })).toBe(pw);
  });

  it('stops at a cross-origin frame instead of throwing', () => {
    const frame = {
      tagName: 'IFRAME',
      get contentDocument(): unknown {
        throw new Error('cross-origin');
      },
    };
    expect(walk({ activeElement: frame })).toBe(frame);
  });

  it('interleaves both descents', () => {
    const leaf = { tagName: 'INPUT', name: 'leaf' };
    const innerHost = { tagName: 'X-F', shadowRoot: { activeElement: leaf } };
    const frame = { tagName: 'IFRAME', contentDocument: { activeElement: innerHost } };
    const outerHost = { tagName: 'X-OUT', shadowRoot: { activeElement: frame } };
    expect(walk({ activeElement: outerHost })).toBe(leaf);
  });

  it('cannot spin on a focus cycle', () => {
    const a: Record<string, unknown> = { tagName: 'X-A' };
    a.shadowRoot = { activeElement: a };
    expect(() => walk({ activeElement: a })).not.toThrow();
  });

  it('returns null when nothing is focused', () => {
    expect(walk({ activeElement: null })).toBeNull();
  });
});

/**
 * `click`'s in-page probe. It runs via callFunctionOn with `this` bound to the
 * resolved element and NO arguments, so any closure or import reference would
 * be a ReferenceError in the page — the tests below run it standalone to pin
 * that, and to pin the two cases where it must refuse rather than report a
 * success the browser never performed.
 */
describe('CLICK_FN (serialised in-page probe)', () => {
  const run = () =>
    new Function(`return (${CLICK_FN});`)() as (this: unknown) => Record<string, unknown>;

  const fakeEl = (over: Record<string, unknown> = {}) => {
    const calls = { scrolled: 0, clicked: 0 };
    const el = {
      tagName: 'BUTTON',
      textContent: 'Send',
      isConnected: true,
      scrollIntoView: () => {
        calls.scrolled += 1;
      },
      click: () => {
        calls.clicked += 1;
      },
      getBoundingClientRect: () => ({ width: 80, height: 24 }),
      ...over,
    };
    return { el, calls };
  };

  it('clicks a normal element and reports its tag and text', () => {
    const { el, calls } = fakeEl();
    const out = run().call(el);
    expect(calls.clicked).toBe(1);
    expect(calls.scrolled).toBe(1);
    expect(out).toEqual({ tag: 'BUTTON', text: 'Send' });
  });

  it('refuses a disabled control WITHOUT clicking — Chrome dispatches nothing there', () => {
    const { el, calls } = fakeEl({ disabled: true });
    const out = run().call(el);
    expect(out).toEqual({ tag: 'BUTTON', blocked: 'disabled' });
    expect(calls.clicked).toBe(0);
  });

  it('refuses a detached node WITHOUT clicking', () => {
    const { el, calls } = fakeEl({ isConnected: false });
    const out = run().call(el);
    expect(out).toEqual({ tag: 'BUTTON', blocked: 'detached' });
    expect(calls.clicked).toBe(0);
  });

  it('still clicks a zero-size element, only FLAGGING it — hidden file inputs are a real pattern', () => {
    // A synthetic .click() on a display:none node works, and clicking a hidden
    // <input type=file> behind a styled label is how upload flows are built.
    // Geometry is mouse_click's business; refusing here would break them.
    const { el, calls } = fakeEl({
      tagName: 'INPUT',
      textContent: '',
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
    });
    const out = run().call(el);
    expect(calls.clicked).toBe(1);
    expect(out).toEqual({ tag: 'INPUT', text: '', hidden: true });
  });

  it('treats a merely falsy `disabled` as enabled (=== true, not truthiness)', () => {
    const { el, calls } = fakeEl({ disabled: false });
    run().call(el);
    expect(calls.clicked).toBe(1);
  });

  it('caps the reported text at 100 chars', () => {
    const { el } = fakeEl({ textContent: 'x'.repeat(500) });
    const out = run().call(el);
    expect(String(out.text)).toHaveLength(100);
  });
});

/**
 * `click` refusing a target that cannot receive the click, end to end over a
 * mocked CDP channel. The probe tests above pin what the page-side function
 * returns; these pin that the tool turns that into the right stable CODE — the
 * thing an autonomous loop branches on.
 */
describe('click refusals', () => {
  const TAB = 21;

  function installChrome(probe: Record<string, unknown>): void {
    const store = new Map<string, unknown>();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          async get(keys: string | string[]) {
            const out: Record<string, unknown> = {};
            for (const k of Array.isArray(keys) ? keys : [keys]) {
              if (store.has(k)) out[k] = store.get(k);
            }
            return out;
          },
          async set(obj: Record<string, unknown>) {
            for (const [k, v] of Object.entries(obj)) store.set(k, v);
          },
          async remove() {},
        },
        session: {
          async get() {
            return {};
          },
          async set() {},
        },
      },
      tabs: {
        async get() {
          return { id: TAB, url: 'https://app.example.com/', title: 'app' };
        },
        onRemoved: { addListener() {} },
      },
      debugger: {
        async attach() {},
        async sendCommand(_t: unknown, method: string) {
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
          if (method === 'DOM.querySelector') return { nodeId: 7 };
          if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
          if (method === 'Runtime.callFunctionOn') return { result: { value: probe } };
          return {};
        },
        onEvent: { addListener() {} },
        onDetach: { addListener() {} },
      },
    };
  }

  async function allowApp(): Promise<void> {
    const { setAllowlist } = await import('../src/storage.js');
    await setAllowlist([{ pattern: 'app.example.com', allowEvaluate: false, addedAt: 0 }]);
  }

  it('turns a disabled control into element_disabled, not ok:true', async () => {
    installChrome({ tag: 'BUTTON', blocked: 'disabled' });
    await allowApp();
    await expect(click({ selector: '#save', tabId: TAB })).rejects.toMatchObject({
      code: 'element_disabled',
    });
  });

  it('a detached @eN is bad_ref — the code whose hint says re-snapshot', async () => {
    installChrome({ tag: 'DIV', blocked: 'detached' });
    await allowApp();
    const { newRef, clearRefsForTab } = await import('../src/tools/refs.js');
    clearRefsForTab(TAB);
    const ref = '@' + newRef(TAB, 77, 'button', 'Send');
    await expect(click({ selector: ref, tabId: TAB })).rejects.toMatchObject({ code: 'bad_ref' });
  });

  it('a detached CSS selector is not_found — do not send the agent after a ref it never held', async () => {
    installChrome({ tag: 'DIV', blocked: 'detached' });
    await allowApp();
    const err = await click({ selector: '#gone', tabId: TAB }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'not_found' });
    expect(String((err as Error).message)).not.toContain('snapshot');
  });

  it('reports a successful click, flagging a zero-size target rather than refusing it', async () => {
    installChrome({ tag: 'INPUT', text: '', hidden: true });
    await allowApp();
    const out = (await click({ selector: '#file', tabId: TAB })) as {
      data: { ok: boolean; hidden?: boolean };
    };
    expect(out.data).toMatchObject({ ok: true, hidden: true });
  });
});

/**
 * read_text's window. The cut was always REPORTED but never resumable: reading
 * past character 20 000 meant re-reading from zero with a bigger cap, paying
 * for the same characters twice and leaving both copies in the context.
 */
describe('capText / parseMaxChars / parseOffset (read_text)', () => {
  const text = 'abcdefghij'; // 10 chars

  it('returns the whole thing untouched when it fits', () => {
    expect(capText(text, 100)).toEqual({ text });
  });

  it('marks a cut and hands back where to continue', () => {
    expect(capText(text, 4)).toEqual({
      text: 'abcd',
      truncated: true,
      totalChars: 10,
      nextOffset: 4,
    });
  });

  it('nextOffset walks the whole string exactly once, with no overlap or gap', () => {
    let offset = 0;
    let assembled = '';
    for (let guard = 0; guard < 10; guard += 1) {
      const page = capText(text, 3, offset);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(text);
  });

  it('reports the total on the final continuation page, so "done" is distinguishable', () => {
    const last = capText(text, 5, 5);
    expect(last).toEqual({ text: 'fghij', offset: 5, totalChars: 10 });
    expect(last.truncated).toBeUndefined();
  });

  it('an offset past the end is empty, not an error — a poll loop must not throw', () => {
    expect(capText(text, 5, 999)).toEqual({ text: '', offset: 10, totalChars: 10 });
  });

  it('never splits a surrogate pair — a lone half is unsignable (protocol.ts) and fails the whole read', () => {
    const emoji = '\u{1F600}'; // 2 UTF-16 code units
    const t = `ab${emoji}cd`; // length 6
    // maxChars 3 would cut between the pair's halves; the cut moves back.
    const page = capText(t, 3);
    expect(page.text).toBe('ab');
    expect(page.nextOffset).toBe(2);
    // Resuming from there yields the whole emoji, never an orphan half.
    const rest = capText(t, 3, page.nextOffset!);
    expect(rest.text).toBe(`${emoji}c`);
    expect(page.text + rest.text).toBe('ab' + emoji + 'c');
    for (const s of [page.text, rest.text]) {
      expect([...s].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(
        true,
      );
    }
  });

  it('takes a whole pair rather than emitting an empty page a paging loop would spin on', () => {
    const t = `\u{1F600}tail`;
    const page = capText(t, 1);
    expect(page.text).toBe('\u{1F600}');
    expect(page.nextOffset).toBe(2);
  });

  it('steps past an orphaned low surrogate when the caller resumes mid-pair', () => {
    const t = `ab\u{1F600}cd`;
    // offset 3 lands INSIDE the pair — an invented or stale offset.
    const page = capText(t, 10, 3);
    expect(page.text).toBe('cd');
    expect(page.offset).toBe(4);
  });

  it('reassembles an emoji-dense string exactly, one code unit at a time', () => {
    const t = '🙂a🙃b😀c';
    let offset = 0;
    let assembled = '';
    for (let guard = 0; guard < 50; guard += 1) {
      const page = capText(t, 1, offset);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(assembled).toBe(t);
  });

  it('caps maxChars so one call cannot dump an unbounded page into the context', () => {
    expect(parseMaxChars(undefined)).toBe(20_000);
    expect(parseMaxChars(500)).toBe(500);
    expect(parseMaxChars(500_000)).toBe(200_000);
    expect(() => parseMaxChars(0)).toThrowError(/maxChars/);
    expect(() => parseMaxChars(-1)).toThrowError(/maxChars/);
    expect(() => parseMaxChars(1.5)).toThrowError(/maxChars/);
  });

  it('validates offset without coercing nonsense to 0', () => {
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset(0)).toBe(0);
    expect(parseOffset(4000)).toBe(4000);
    expect(() => parseOffset(-1)).toThrowError(/offset/);
    expect(() => parseOffset(2.5)).toThrowError(/offset/);
    expect(() => parseOffset('lots')).toThrowError(/offset/);
  });
});

/**
 * fill's insertText read-back. method:'value' was already hardened against
 * silently no-opping; its remedy is to fall through to insertText, which
 * verified nothing. The probe must report WHETHER the text landed without ever
 * carrying the text back (invariant #5).
 */
describe('FILL_READBACK_FN (serialised in-page probe)', () => {
  const run = () =>
    new Function(`return (${FILL_READBACK_FN});`)() as (
      this: unknown,
      expected: string,
    ) => { len: number; matched: boolean };

  // The probe consults `this` AND the deepest focused leaf. A bare fake with no
  // ownerDocument exercises the `this`-only path (globalThis.document is
  // undefined under vitest, and the probe tolerates that).
  const doc = (activeElement: unknown) => ({ activeElement });

  it('confirms a value that landed', () => {
    expect(run().call({ value: 'hello', isContentEditable: false }, 'hello')).toEqual({
      len: 5,
      matched: true,
    });
  });

  it('finds the text through a delegatesFocus shadow host, where `this` is not the field', () => {
    // The host has no value of its own; insertText went to the inner control.
    const inner = { value: 'hello', isContentEditable: false };
    const host = {
      isContentEditable: false,
      shadowRoot: { activeElement: inner },
      ownerDocument: doc(undefined),
    };
    // activeElement retargets to the host, and the walk descends from there.
    (host.ownerDocument as { activeElement: unknown }).activeElement = host;
    expect(run().call(host, 'hello')).toEqual({ len: 5, matched: true });
  });

  it('does NOT report a successful fill inside a same-origin iframe as a failure', () => {
    // Regression: reading only the main frame's focused leaf gets the <iframe>
    // ELEMENT, which has no value — a successful write read as "nothing landed".
    // Starting from the node's OWN document makes the field its own activeElement.
    const field = { value: 'hello', isContentEditable: false, ownerDocument: doc(undefined) };
    (field.ownerDocument as { activeElement: unknown }).activeElement = field;
    expect(run().call(field, 'hello')).toEqual({ len: 5, matched: true });
  });

  it('descends into a same-origin iframe when the walk lands on one', () => {
    const inner = { value: 'hello', isContentEditable: false };
    const iframe = { tagName: 'IFRAME', isContentEditable: false, contentDocument: doc(inner) };
    const wrapper = { isContentEditable: false, ownerDocument: doc(iframe) };
    expect(run().call(wrapper, 'hello')).toEqual({ len: 5, matched: true });
  });

  it('stops at a cross-origin iframe instead of throwing', () => {
    const iframe = {
      tagName: 'IFRAME',
      isContentEditable: false,
      get contentDocument(): unknown {
        throw new Error('cross-origin');
      },
    };
    const field = { value: 'hello', isContentEditable: false, ownerDocument: doc(iframe) };
    // Falls back to `this`, which IS the field here.
    expect(run().call(field, 'hello')).toEqual({ len: 5, matched: true });
  });

  it('runs with no ownerDocument at all — the literal must be self-contained', () => {
    expect(run().call({ value: 'hello', isContentEditable: false }, 'hello')).toEqual({
      len: 5,
      matched: true,
    });
  });

  it('cannot spin on a self-referential focus chain', () => {
    const loop: Record<string, unknown> = { isContentEditable: false };
    loop.shadowRoot = { activeElement: loop };
    const field = { value: '', isContentEditable: false, ownerDocument: doc(loop) };
    expect(run().call(field, 'x')).toEqual({ len: 0, matched: false });
  });

  it('reports a maxlength truncation as not-applied WITH the length that tells you why', () => {
    expect(run().call({ value: 'hello wo', isContentEditable: false }, 'hello world')).toEqual({
      len: 8,
      matched: false,
    });
  });

  it('reports a write that did not land at all', () => {
    expect(run().call({ value: '', isContentEditable: false }, 'hello')).toEqual({
      len: 0,
      matched: false,
    });
  });

  it('accepts a field the editor concatenated into, matching on containment', () => {
    expect(run().call({ value: 'draft: hello', isContentEditable: false }, 'hello')).toEqual({
      len: 12,
      matched: true,
    });
  });

  it('reads contenteditable through innerText', () => {
    expect(
      run().call({ isContentEditable: true, innerText: 'typed', textContent: 'x' }, 'typed'),
    ).toEqual({ len: 5, matched: true });
  });

  it('handles a node with no value at all without throwing', () => {
    expect(run().call({ isContentEditable: false }, 'x')).toEqual({ len: 0, matched: false });
  });

  it('classifies the three outcomes a read-back can honestly reach', () => {
    expect(classifyApplied(true, 5)).toBe('yes');
    // Empty field: nothing landed, and saying so is safe.
    expect(classifyApplied(false, 0)).toBe('no');
    // Non-empty but not literally our text — a mask, a normaliser, or a
    // maxlength cut. Calling this a failure would be a WRONG verdict on a fill
    // that worked, which is worse than admitting the ambiguity.
    expect(classifyApplied(false, 14)).toBe('unclear'); // "+7 (912) 345-67" mask
    expect(classifyApplied(false, 3)).toBe('unclear'); // maxlength truncation
  });

  it('never returns the field contents — only a boolean and a length', () => {
    const out = run().call({ value: 'sup3rs3cret', isContentEditable: false }, 'sup3rs3cret');
    expect(Object.keys(out).sort()).toEqual(['len', 'matched']);
    expect(JSON.stringify(out)).not.toContain('sup3rs3cret');
  });
});
