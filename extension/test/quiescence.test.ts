import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQuiescenceObserver, CREATE_QUIESCENCE_PROBE } from '../src/tools/quiescence.js';

describe('per-wait DOM observer', () => {
  let deliver: (records: unknown[]) => void;
  let queued: unknown[];
  const observe = vi.fn();
  const disconnect = vi.fn();
  const doc = {} as Document;

  beforeEach(() => {
    vi.useFakeTimers();
    queued = [];
    observe.mockClear();
    disconnect.mockClear();
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: (records: unknown[]) => void) {
          deliver = callback;
        }
        observe = observe;
        disconnect = disconnect;
        takeRecords() {
          const records = queued;
          queued = [];
          return records;
        }
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('observes child, text and attribute changes even before a body exists', () => {
    const observer = createQuiescenceObserver(doc);
    expect(observe).toHaveBeenCalledWith(doc, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    expect(observer.sample()).toBe(0);
    expect(observer.sample()).toBe(0);
    observer.stop();
  });

  it('counts delivered mutations without reading their contents', () => {
    const observer = createQuiescenceObserver(doc);
    const record = {
      get oldValue() {
        throw new Error('must not read content');
      },
    };
    deliver([record]);
    expect(observer.sample()).toBe(1);
    deliver([record, record]); // Includes changes that revert between polls.
    expect(observer.sample()).toBe(2);
    deliver([]);
    expect(observer.sample()).toBe(2);
    observer.stop();
  });

  it('drains records not yet delivered to the callback', () => {
    const observer = createQuiescenceObserver(doc);
    queued = [{}];
    expect(observer.sample()).toBe(1);
    expect(observer.sample()).toBe(1);
    observer.stop();
  });

  it('disconnects and invalidates readings on stop, clearing the fallback timer', () => {
    const observer = createQuiescenceObserver(doc);
    observer.stop();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(observer.sample()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires even when the extension never sends cleanup', () => {
    const observer = createQuiescenceObserver(doc);
    vi.advanceTimersByTime(31_000);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(observer.sample()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disconnects if creation fails after observing started', () => {
    vi.stubGlobal('setTimeout', () => {
      throw new Error('page shadowed setTimeout');
    });
    expect(() => createQuiescenceObserver(doc)).toThrow('page shadowed setTimeout');
    expect(observe).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('serialises without module references or caller-provided code', () => {
    const run = new Function('document', `return ${CREATE_QUIESCENCE_PROBE};`) as (
      doc: Document,
    ) => ReturnType<typeof createQuiescenceObserver>;
    const observer = run(doc);
    deliver([{}]);
    expect(observer.sample()).toBe(1);
    observer.stop();
  });
});
