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
let click: (a: Record<string, unknown>, c?: unknown) => Promise<unknown>;

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onDetach: { addListener() {} } },
  };
  ({ attributesIndicatePassword, ensureFocusLanded, CLICK_FN, click } =
    (await import('../src/tools/dom.js')) as unknown as {
      attributesIndicatePassword: typeof attributesIndicatePassword;
      ensureFocusLanded: typeof ensureFocusLanded;
      CLICK_FN: string;
      click: typeof click;
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
