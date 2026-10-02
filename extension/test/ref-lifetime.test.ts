/**
 * When a tab's `@eN` ids may restart at `e1` (invariant #7).
 *
 * The ref MAP dies with the CDP session; the COUNTER dies only with the tab.
 * A detach — the human's Cancel on the debugging bar, an explicit `detach()`,
 * whatever reason Chrome gives — leaves a live page behind, and restarting at
 * `e1` there let the next snapshot re-issue `@e5` while the agent still held
 * the old one: a silent rebind on the same document, which not even the loader
 * id check can catch. Only `tabs.onRemoved` restarts the numbering.
 *
 * Every test loads a FRESH cdp.ts/refs.ts (vi.resetModules) so the listeners it
 * registers are the ones this file's chrome stub captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const TAB = 9;
let removedListeners: Listener[];
let detachListeners: Listener[];

beforeEach(() => {
  vi.resetModules();
  removedListeners = [];
  detachListeners = [];
  vi.stubGlobal('chrome', {
    debugger: {
      sendCommand: async () => ({}),
      detach: vi.fn().mockResolvedValue(undefined),
      onDetach: { addListener: (l: Listener) => detachListeners.push(l) },
      onEvent: { addListener: () => undefined },
    },
    tabs: { onRemoved: { addListener: (l: Listener) => removedListeners.push(l) } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  const cdp = await import('../src/tools/cdp.js');
  const refs = await import('../src/tools/refs.js');
  const { resolveSelectorOrRef } = await import('../src/tools/resolve.js');
  // Two refs, as a snapshot would have handed out.
  refs.newRef(TAB, 100, 'button', 'Save', 'L1');
  refs.newRef(TAB, 101, 'button', 'Delete', 'L1');
  return { cdp, refs, resolveSelectorOrRef };
}

const fire = (listeners: Listener[], ...args: unknown[]) => listeners.forEach((l) => l(...args));

describe('a debugger detach wipes the map but keeps counting', () => {
  it.each(['canceled_by_user', 'target_closed'])(
    'onDetach(%s): a held @eN misses as bad_ref and the next snapshot does not restart at e1',
    async (reason) => {
      const { refs, resolveSelectorOrRef } = await load();
      expect(detachListeners).toHaveLength(1);
      fire(detachListeners, { tabId: TAB }, reason);

      await expect(resolveSelectorOrRef(TAB, '@e2', 'click')).rejects.toMatchObject({
        code: 'bad_ref',
      });
      // A re-snapshot after re-attaching continues the numbering, so `@e2`
      // cannot come back naming some other element of the same page.
      expect(refs.newRef(TAB, 200, 'button', 'Other', 'L1')).toBe('e3');
      expect(refs.getRef(TAB, '@e2')).toBeNull();
    },
  );

  it('an explicit detach() keeps counting too', async () => {
    const { cdp, refs } = await load();
    await cdp.detach(TAB);
    expect(refs.getRef(TAB, '@e1')).toBeNull();
    expect(refs.newRef(TAB, 200, 'button', 'Other', 'L1')).toBe('e3');
  });

  it('still clears the SESSION half on detach (emulation, captures, hygiene)', async () => {
    const { cdp } = await load();
    cdp.recordEmulatedDsf(TAB, 2);
    fire(detachListeners, { tabId: TAB }, 'canceled_by_user');
    expect(cdp.getEmulatedDsf(TAB)).toBeUndefined();
  });
});

describe('a closed tab restarts at e1', () => {
  it('tabs.onRemoved drops the map AND the counter', async () => {
    const { refs } = await load();
    expect(removedListeners).toHaveLength(1);
    fire(removedListeners, TAB, { windowId: 1, isWindowClosing: false });
    expect(refs.getRef(TAB, '@e1')).toBeNull();
    expect(refs.refWatermark(TAB)).toBe(0);
    expect(refs.newRef(TAB, 300, 'button', 'Fresh', 'L9')).toBe('e1');
  });

  it('a detach that arrives AFTER the removal leaves nothing behind', async () => {
    // Chrome may deliver onDetach(target_closed) after tabs.onRemoved; the reset
    // must not resurrect a map or a counter for a tab that no longer exists.
    const { refs } = await load();
    fire(removedListeners, TAB, { windowId: 1, isWindowClosing: false });
    fire(detachListeners, { tabId: TAB }, 'target_closed');
    expect(refs.refWatermark(TAB)).toBe(0);
    expect(refs.getRef(TAB, '@e1')).toBeNull();
  });
});
