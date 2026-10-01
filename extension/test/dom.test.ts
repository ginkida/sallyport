/**
 * `fill`'s password gate reads the target's tag and `type` from the browser
 * DOM via CDP `DOM.describeNode` rather than a page-readable `this.type`
 * getter, so a hostile page can't shadow the gate with a throwing or lying
 * accessor. The pure decision is focus.ts:domNodeIsPassword (tested there);
 * `targetIsPasswordField` pins the read around it and its fail-closed rule.
 *
 * `dom.ts` imports `cdp.ts`, which registers `chrome.*` listeners at module
 * load, so we stub the minimal surface and import the module dynamically once
 * the stub is in place (vitest runs under node with no real `chrome`).
 */

import { beforeAll, describe, expect, it } from 'vitest';

let targetIsPasswordField: (tabId: number, objectId: string) => Promise<boolean>;
let ensureFocusLanded: (focused: boolean | undefined) => void;
let CLICK_FN: string;
let FILL_GUARD_FN: string;
let frameGateUrl: (t: unknown, id: string) => string | null;
let findBody: (n: unknown, d: number) => { backendNodeId?: unknown } | undefined;
let FILL_READBACK_FN: string;
let classifyApplied: typeof import('../src/tools/dom.js').classifyApplied;
let click: (a: Record<string, unknown>, c?: unknown) => Promise<unknown>;

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onDetach: { addListener() {} } },
  };
  ({
    targetIsPasswordField,
    ensureFocusLanded,
    CLICK_FN,
    FILL_GUARD_FN,
    frameGateUrl,
    findBody,
    click,
    FILL_READBACK_FN,
    classifyApplied,
  } = (await import('../src/tools/dom.js')) as unknown as {
    targetIsPasswordField: typeof targetIsPasswordField;
    ensureFocusLanded: typeof ensureFocusLanded;
    CLICK_FN: string;
    FILL_GUARD_FN: string;
    frameGateUrl: typeof frameGateUrl;
    findBody: typeof findBody;
    click: typeof click;
    FILL_READBACK_FN: string;
    classifyApplied: typeof classifyApplied;
  });
});

describe("targetIsPasswordField (fill's up-front gate)", () => {
  function answer(node: unknown) {
    const calls: string[] = [];
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
      ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
      debugger: {
        onDetach: { addListener() {} },
        async sendCommand(_t: unknown, method: string) {
          calls.push(method);
          if (method === 'DOM.describeNode') return { node };
          // What Chrome answers when nothing has fetched the document yet — the
          // state right after an a11y snapshot. Must not be consulted at all.
          if (method === 'DOM.requestNode') return { nodeId: 0 };
          return {};
        },
      },
    };
    return calls;
  }

  it('passes a plain text field reached by @eN before any DOM.getDocument', async () => {
    // requestNode's nodeId 0 made this fail closed as password_field, and the
    // error told the agent to pass allowPassword=true.
    const calls = answer({ nodeName: 'INPUT', attributes: ['id', 'name', 'type', 'text'] });
    await expect(targetIsPasswordField(1, 'obj')).resolves.toBe(false);
    expect(calls).toEqual(['DOM.describeNode']);
  });

  it('refuses a password field, however its type is cased', async () => {
    answer({ nodeName: 'input', attributes: ['type', 'PassWord'] });
    await expect(targetIsPasswordField(1, 'obj')).resolves.toBe(true);
  });

  it('refuses a password-typed custom host whose closed shadow root hides the field', async () => {
    answer({ nodeName: 'X-PASS', attributes: ['type', 'password'] });
    await expect(targetIsPasswordField(1, 'obj')).resolves.toBe(true);
  });

  it('fails closed on a node it cannot classify', async () => {
    answer({ nodeName: 'INPUT', attributes: 'type=password' });
    await expect(targetIsPasswordField(1, 'obj')).resolves.toBe(true);
    answer(undefined);
    await expect(targetIsPasswordField(1, 'obj')).resolves.toBe(true);
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

  it('refuses a control disabled by an ancestor <fieldset disabled>, without clicking', () => {
    // .disabled is false there; :disabled is what the browser actually honours.
    const { el, calls } = fakeEl({ disabled: false, matches: (s: string) => s === ':disabled' });
    expect(run().call(el)).toMatchObject({ blocked: 'disabled' });
    expect(calls.clicked).toBe(0);
  });

  it('still clicks when matches() throws on a page that broke it', () => {
    const { el, calls } = fakeEl({
      matches: () => {
        throw new Error('broken');
      },
    });
    run().call(el);
    expect(calls.clicked).toBe(1);
  });

  it('dispatches a click on an element with no .click() (SVG, MathML) — as a PointerEvent', () => {
    const events: Array<{ ctor: string; type: string; init: Record<string, unknown> }> = [];
    const make = (ctor: string) =>
      class {
        ctor = ctor;
        constructor(
          public type: string,
          public init: Record<string, unknown>,
        ) {}
      };
    const view = { MouseEvent: make('MouseEvent'), PointerEvent: make('PointerEvent') };
    const { el } = fakeEl({
      tagName: 'svg',
      click: undefined,
      ownerDocument: { defaultView: view },
      dispatchEvent: (e: { ctor: string; type: string; init: Record<string, unknown> }) => {
        events.push(e);
        return true;
      },
    });
    const out = run().call(el);
    expect(out.tag).toBe('svg');
    expect(events).toHaveLength(1);
    // What Chrome's own .click() fires, so an `instanceof PointerEvent` handler reacts.
    expect(events[0]).toMatchObject({
      ctor: 'PointerEvent',
      type: 'click',
      init: { bubbles: true, cancelable: true, composed: true, view, pointerId: -1 },
    });
  });

  it('falls back to MouseEvent where there is no PointerEvent', () => {
    const events: Array<{ ctor: string }> = [];
    const { el } = fakeEl({
      click: undefined,
      ownerDocument: {
        defaultView: {
          MouseEvent: class {
            ctor = 'MouseEvent';
          },
        },
      },
      dispatchEvent: (e: { ctor: string }) => {
        events.push(e);
        return true;
      },
    });
    run().call(el);
    expect(events[0].ctor).toBe('MouseEvent');
  });

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

  it('a probe that reports an exception is an error even if a value came along', async () => {
    installChrome({ tag: 'BUTTON' });
    await allowApp();
    const { click: clickTool } = await import('../src/tools/dom.js');
    const send = chrome.debugger.sendCommand as unknown as (
      t: unknown,
      m: string,
    ) => Promise<unknown>;
    (chrome.debugger as unknown as { sendCommand: typeof send }).sendCommand = async (t, m) =>
      m === 'Runtime.callFunctionOn'
        ? {
            result: { value: { tag: 'BUTTON' } },
            exceptionDetails: {
              text: 'Uncaught',
              exception: { description: 'TypeError: boom \uD83D\n    at page.js:1:1' },
            },
          }
        : send(t, m);
    const err = clickTool({ selector: '#save', tabId: TAB });
    await expect(err).rejects.toMatchObject({ code: 'error' });
    // First line only, and no lone surrogate half (it would make the error unsignable).
    await expect(err).rejects.toThrow(/did not run \(TypeError: boom \)/);
  });

  it('a click that threw in the page is an error, never ok:true', async () => {
    // No value comes back when the probe throws; defaulting to {} answered
    // ok:true for a click that never happened.
    installChrome(undefined as never);
    await allowApp();
    await expect(click({ selector: '#save', tabId: TAB })).rejects.toMatchObject({
      code: 'error',
      message: expect.stringContaining('did not run'),
    });
  });

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

  it('confirms a value that landed', () => {
    expect(run().call({ value: 'hello', isContentEditable: false }, 'hello')).toEqual({
      len: 5,
      matched: true,
    });
  });

  it('reads a contenteditable by its text', () => {
    expect(run().call({ isContentEditable: true, innerText: 'hi there' }, 'there')).toEqual({
      len: 8,
      matched: true,
    });
  });

  it('reads ONLY the write node — never wherever focus went after the write', () => {
    // A card form that advanced focus to its CVV: the probe has no way to
    // reach it, because nothing but `this` is consulted.
    const field = {
      value: '',
      isContentEditable: false,
      ownerDocument: { activeElement: { value: '123', isContentEditable: false } },
    };
    expect(run().call(field, 'x')).toEqual({ len: 0, matched: false });
  });

  it('answers nothing-landed for a node with no value', () => {
    expect(run().call({ isContentEditable: false }, 'x')).toEqual({ len: 0, matched: false });
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

describe('read_text says what it could not see', () => {
  const TAB2 = 31;

  /** A page whose body text is `text`, with the frame tree the browser reports.
   * `frameTree: null` models a browser that refuses the command. */
  function installChrome(text: string, frameTree: unknown): void {
    const store = new Map<string, unknown>();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          async get(keys: string | string[]) {
            const out: Record<string, unknown> = {};
            for (const k of Array.isArray(keys) ? keys : [keys])
              if (store.has(k)) out[k] = store.get(k);
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
          return { id: TAB2, url: 'https://shop.example/pay', title: 'pay' };
        },
        onRemoved: { addListener() {} },
      },
      debugger: {
        async attach() {},
        async sendCommand(_t: unknown, method: string) {
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
          if (method === 'DOM.querySelector') return { nodeId: 7 };
          if (method === 'DOM.resolveNode') return { object: { objectId: 'body' } };
          if (method === 'Runtime.callFunctionOn') return { result: { value: text } };
          if (method === 'Page.getFrameTree') {
            if (!frameTree) throw new Error('not available');
            return frameTree;
          }
          return {};
        },
        onEvent: { addListener() {} },
        onDetach: { addListener() {} },
      },
    };
  }

  const payFrames = {
    frameTree: {
      frame: { url: 'https://shop.example/pay' },
      childFrames: [{ frame: { url: 'https://pay.example/card?token=secret' } }],
    },
  };

  async function load() {
    const { readText } = await import('../src/tools/dom.js');
    const { setAllowlist } = await import('../src/storage.js');
    const { resetAttachedTabs } = await import('../src/tools/cdp.js');
    resetAttachedTabs();
    await setAllowlist([{ pattern: 'shop.example', allowEvaluate: false, addedAt: 0 }]);
    return readText;
  }

  it('reports the frames whose text is NOT in the answer', async () => {
    // The body probe does not cross a frame boundary, so a checkout page reads
    // as its shell. Without this the agent sees a short string and no reason.
    installChrome('Complete your purchase', payFrames);
    const readText = await load();
    const out = (await readText({ tabId: TAB2 }, undefined)) as {
      data: { text: string; frames?: string[] };
    };
    expect(out.data.text).toBe('Complete your purchase');
    expect(out.data.frames).toEqual(['https://pay.example']); // origin only, no token
  });

  it('reports them on an EMPTY read too — where the silence is worst', async () => {
    installChrome('', payFrames);
    const readText = await load();
    const out = (await readText({ tabId: TAB2 }, undefined)) as {
      data: { text: string; frames?: string[] };
    };
    expect(out.data).toMatchObject({ text: '', frames: ['https://pay.example'] });
  });

  it('says nothing when the page has no frames', async () => {
    installChrome('plain page', { frameTree: { frame: { url: 'https://shop.example/pay' } } });
    const readText = await load();
    const out = (await readText({ tabId: TAB2 }, undefined)) as { data: { frames?: unknown } };
    expect(out.data.frames).toBeUndefined();
  });

  it('still returns the text when the browser will not answer about frames', async () => {
    installChrome('plain page', null);
    const readText = await load();
    const out = (await readText({ tabId: TAB2 }, undefined)) as {
      data: { text: string; frames?: unknown };
    };
    expect(out.data.text).toBe('plain page');
    expect(out.data.frames).toBeUndefined();
  });
});

describe("FILL_GUARD_FN (fill's insert fence, run in an isolated world)", () => {
  type Listener = (e: Record<string, unknown>) => void;
  type Fake = Record<string, unknown>;
  // A document with N nested shadow roots; the write node is in the innermost.
  // Focus is modelled exactly as the browser exposes it: each root's
  // activeElement is its node on the focus path.
  function world(depth: number) {
    const listeners = new Map<string, Listener>();
    const win: Fake = {
      addEventListener: (t: string, l: Listener) => void listeners.set(t, l),
      removeEventListener: (t: string) => void listeners.delete(t),
    };
    const doc: Fake = { nodeType: 9, defaultView: win };
    const roots: Fake[] = [doc];
    const nodes: Fake[] = [];
    let root = doc;
    for (let i = 0; i <= depth; i++) {
      const r = root;
      const node: Fake = { getRootNode: () => r };
      r.activeElement = node;
      nodes.push(node);
      if (i < depth) {
        root = { nodeType: 11, host: node };
        roots.push(root);
      }
    }
    return { write: nodes[nodes.length - 1], roots, nodes, listeners };
  }
  function arm(write: Fake) {
    return (
      new Function(`return (${FILL_GUARD_FN});`)() as (this: unknown) => {
        finish: () => { seen: number; blocked: number };
      }
    ).call(write);
  }
  function fire(
    w: ReturnType<typeof world>,
    type: string,
    isTrusted = true,
    inputType = 'insertText',
  ) {
    const e: Record<string, unknown> & { prevented?: boolean } = {
      type,
      isTrusted,
      inputType,
      preventDefault() {
        e.prevented = true;
      },
      stopImmediatePropagation() {},
    };
    w.listeners.get(type)?.(e);
    return e;
  }
  const g = globalThis as unknown as { setTimeout: unknown; clearTimeout: unknown };

  it('lets an insert into the write node through, counts it, and removes itself', () => {
    const w = world(0);
    const guard = arm(w.write);
    expect(fire(w, 'beforeinput').prevented).toBeUndefined();
    expect(fire(w, 'textInput').prevented).toBeUndefined();
    expect(guard.finish()).toEqual({ seen: 1, blocked: 0 });
    expect(w.listeners.size).toBe(0);
  });

  it('cancels an insert once focus has moved to another field', () => {
    const w = world(0);
    const guard = arm(w.write);
    w.roots[0].activeElement = { id: 'pw' };
    expect(fire(w, 'beforeinput').prevented).toBe(true);
    expect(guard.finish()).toEqual({ seen: 0, blocked: 1 });
  });

  it('catches a move made by a page beforeinput handler, at textInput', () => {
    // beforeinput passes (focus still ours), then the page moves focus; the
    // insert follows focus, and textInput is where that becomes visible.
    const w = world(0);
    const guard = arm(w.write);
    expect(fire(w, 'beforeinput').prevented).toBeUndefined();
    w.roots[0].activeElement = { id: 'pw' };
    expect(fire(w, 'textInput').prevented).toBe(true);
    expect(guard.finish()).toEqual({ seen: 1, blocked: 1 });
  });

  it('tells two fields in ONE shadow root apart, closed roots included', () => {
    const w = world(1);
    const guard = arm(w.write);
    // The document still sees the same host; only the shadow root knows.
    w.roots[1].activeElement = { id: 'sibling-password' };
    expect(fire(w, 'beforeinput').prevented).toBe(true);
    expect(guard.finish()).toEqual({ seen: 0, blocked: 1 });
  });

  it('checks every level of a nested component', () => {
    const w = world(2);
    arm(w.write);
    expect(fire(w, 'beforeinput').prevented).toBeUndefined();
    w.roots[1].activeElement = { id: 'other-host' };
    expect(fire(w, 'beforeinput').prevented).toBe(true);
  });

  it('ignores page-dispatched (untrusted) events both ways', () => {
    const w = world(0);
    const guard = arm(w.write);
    fire(w, 'beforeinput', false);
    w.roots[0].activeElement = { id: 'pw' };
    expect(fire(w, 'beforeinput', false).prevented).toBeUndefined();
    expect(guard.finish()).toEqual({ seen: 0, blocked: 0 });
  });

  it('ignores non-insert beforeinput types', () => {
    const w = world(0);
    const guard = arm(w.write);
    w.roots[0].activeElement = { id: 'other' };
    fire(w, 'beforeinput', true, 'deleteContentBackward');
    expect(guard.finish()).toEqual({ seen: 0, blocked: 0 });
  });

  it('refuses to arm on a node outside any document', () => {
    const orphanHost = { getRootNode: () => ({ nodeType: 1 }) };
    const orphanRoot = { nodeType: 11, host: orphanHost };
    expect(() => arm({ getRootNode: () => orphanRoot })).toThrow(/not in a document/);
    expect(() => arm({ getRootNode: () => ({ nodeType: 1 }) })).toThrow(/not in a document/);
    expect(() => arm({ getRootNode: () => ({ nodeType: 9, defaultView: null }) })).toThrow(
      /not in a document/,
    );
  });

  it('expires on its own if finish never comes', () => {
    const saved = { st: g.setTimeout, ct: g.clearTimeout };
    let expire: (() => void) | null = null;
    g.setTimeout = (fn: () => void) => ((expire = fn), 1);
    g.clearTimeout = () => {};
    try {
      const w = world(1);
      arm(w.write);
      expect(w.listeners.size).toBe(2);
      expire!();
      expect(w.listeners.size).toBe(0);
    } finally {
      g.setTimeout = saved.st;
      g.clearTimeout = saved.ct;
    }
  });
});

describe('frameGateUrl (an editor frame is allowlisted by its own origin)', () => {
  const tree = {
    frame: {
      id: 'main',
      url: 'https://app.example/app/edit',
      securityOrigin: 'https://app.example',
    },
    childFrames: [
      {
        frame: {
          id: 'http',
          url: 'https://admin.example/x',
          securityOrigin: 'https://admin.example',
        },
        childFrames: [
          {
            frame: {
              id: 'nested-blank',
              url: 'about:blank',
              securityOrigin: 'https://app.example',
            },
          },
        ],
      },
      { frame: { id: 'blank', url: 'about:blank', securityOrigin: 'https://app.example' } },
      { frame: { id: 'sandboxed', url: 'about:srcdoc', securityOrigin: 'null' } },
    ],
  };
  it('uses the frame url, not the tab url', () => {
    expect(frameGateUrl(tree, 'http')).toBe('https://admin.example/x');
  });
  it("uses the parent's url for an about:blank editor of the parent's origin", () => {
    // so a path-pinned entry for /app/* still admits it
    expect(frameGateUrl(tree, 'blank')).toBe('https://app.example/app/edit');
  });
  it('falls back to the bare origin when the parent is another origin', () => {
    expect(frameGateUrl(tree, 'nested-blank')).toBe('https://app.example/');
  });
  it('gives null for an opaque origin or an unknown frame', () => {
    expect(frameGateUrl(tree, 'sandboxed')).toBeNull();
    expect(frameGateUrl(tree, 'nope')).toBeNull();
  });
});

describe("findBody (an editor frame's body, browser-described)", () => {
  it('finds BODY under the document within the depth, case-insensitively', () => {
    const doc = {
      nodeName: '#document',
      children: [
        { nodeName: 'html' },
        {
          nodeName: 'HTML',
          children: [{ nodeName: 'HEAD' }, { nodeName: 'body', backendNodeId: 9 }],
        },
      ],
    };
    expect(findBody(doc, 3)?.backendNodeId).toBe(9);
  });

  it('gives up past the depth or on nothing', () => {
    expect(findBody(undefined, 3)).toBeUndefined();
    expect(
      findBody(
        { nodeName: 'X', children: [{ nodeName: 'Y', children: [{ nodeName: 'BODY' }] }] },
        1,
      ),
    ).toBeUndefined();
  });
});
