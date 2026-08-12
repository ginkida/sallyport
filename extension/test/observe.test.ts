/**
 * `observe` — the optional post-action look at the page.
 *
 * It exists because every action tool used to end blind: `navigate`/`reload`
 * invalidate every `@eN`, so a follow-up `snapshot` was structural rather than
 * a choice, and that follow-up costs a whole model turn. These tests pin the
 * argument contract and the two properties that keep it safe to fold into an
 * action's result — it never fails the action, and it never returns more than
 * it was asked for.
 */

import { beforeAll, describe, expect, it } from 'vitest';

let parseObserve: typeof import('../src/tools/observe.js').parseObserve;
let runObserve: typeof import('../src/tools/observe.js').runObserve;

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onDetach: { addListener() {} } },
  };
  ({ parseObserve, runObserve } = await import('../src/tools/observe.js'));
});

describe('parseObserve', () => {
  it('is absent unless asked for — observation is opt-in', () => {
    expect(parseObserve(undefined, 'click')).toBeNull();
    expect(parseObserve(null, 'click')).toBeNull();
  });

  it('accepts the two snapshot shapes', () => {
    expect(parseObserve({ snapshot: 'compact' }, 'click')).toEqual({
      snapshot: 'compact',
      text: false,
      maxChars: 2000,
    });
    expect(parseObserve({ snapshot: 'tree' }, 'click')?.snapshot).toBe('tree');
  });

  it('reads snapshot:true as the CHEAP form, not the tree', () => {
    // `true` is what a model types when it means "yes, show me". Rejecting it
    // would cost a round-trip; defaulting it to the tree would cost tokens.
    expect(parseObserve({ snapshot: true }, 'click')?.snapshot).toBe('compact');
  });

  it('accepts text on its own', () => {
    expect(parseObserve({ text: true }, 'navigate')).toEqual({
      snapshot: null,
      text: true,
      maxChars: 2000,
    });
  });

  it('refuses an observation that would observe nothing', () => {
    expect(() => parseObserve({}, 'click')).toThrowError(/snapshot and\/or text/);
    expect(() => parseObserve({ text: false }, 'click')).toThrowError(/snapshot and\/or text/);
    expect(() => parseObserve({ snapshot: false }, 'click')).toThrowError(/snapshot and\/or text/);
  });

  it('caps maxChars — this payload rides along with an action the agent did not ask to read', () => {
    expect(parseObserve({ text: true, maxChars: 500 }, 'click')?.maxChars).toBe(500);
    expect(parseObserve({ text: true, maxChars: 999_999 }, 'click')?.maxChars).toBe(20_000);
  });

  it('fails loudly on a malformed shape rather than silently observing nothing', () => {
    expect(() => parseObserve('compact', 'click')).toThrowError(/observe must be an object/);
    expect(() => parseObserve([], 'click')).toThrowError(/observe must be an object/);
    expect(() => parseObserve({ snapshot: 'full' }, 'click')).toThrowError(/'compact' or 'tree'/);
    expect(() => parseObserve({ text: true, maxChars: 0 }, 'click')).toThrowError(/maxChars/);
    expect(() => parseObserve({ text: true, maxChars: 1.5 }, 'click')).toThrowError(/maxChars/);
  });

  it('names the calling tool in its errors, so a batched call says which argument was wrong', () => {
    expect(() => parseObserve({}, 'send_keys')).toThrowError(/send_keys/);
  });
});

/**
 * The two properties that make `observe` safe to fold into an action's result:
 * it re-gates the page it is about to read, and it never throws.
 */
describe('runObserve', () => {
  const TAB = 31;
  const spec = { snapshot: 'compact' as const, text: true, maxChars: 2000 };

  function installChrome(opts: { url: string; cdpThrows?: boolean }): { cdpCalls: string[] } {
    const cdpCalls: string[] = [];
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
          return { id: TAB, url: opts.url };
        },
        onRemoved: { addListener() {} },
      },
      debugger: {
        async attach() {},
        async sendCommand(_t: unknown, method: string) {
          cdpCalls.push(method);
          if (opts.cdpThrows) throw new Error('Target closed.');
          return {};
        },
        onEvent: { addListener() {} },
        onDetach: { addListener() {} },
      },
    };
    return { cdpCalls };
  }

  async function allow(pattern: string): Promise<void> {
    const { setAllowlist } = await import('../src/storage.js');
    await setAllowlist([{ pattern, allowEvaluate: false, addedAt: 0 }]);
  }

  it('refuses to read a page the allowlist does not cover, and reads NOTHING', async () => {
    // The case this exists for: navigate gates the REQUESTED url, the page
    // redirects, and observing inside the action would be the one path that
    // reads a page the allowlist never approved (invariant #3).
    const { cdpCalls } = installChrome({ url: 'https://tracker.evil.example/x' });
    await allow('app.example.com');
    const out = await runObserve(TAB, spec);
    expect(out).toEqual({ skipped: 'domain_not_allowed' });
    expect(cdpCalls).toEqual([]); // not a single CDP command was issued
  });

  it('reports a vanished tab distinctly from a refused one', async () => {
    (globalThis as unknown as { chrome: Record<string, unknown> }).chrome = {
      ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
      tabs: {
        async get() {
          throw new Error('No tab with id: 31');
        },
        onRemoved: { addListener() {} },
      },
    };
    const out = await runObserve(TAB, spec);
    expect(out).toEqual({ skipped: 'tab_gone' });
  });

  it('folds a failure into the result instead of throwing — the action already happened', async () => {
    installChrome({ url: 'https://app.example.com/dash', cdpThrows: true });
    await allow('app.example.com');
    const out = await runObserve(TAB, spec);
    expect(out.error).toBeDefined();
    expect(out.skipped).toBeUndefined();
  });
});
