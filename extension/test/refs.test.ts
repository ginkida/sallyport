/**
 * Per-tab `@eN` ref map.
 *
 * The whole point of these refs is *isolation*: snapshot of tab A must
 * never invalidate or alias refs for tab B, and a ref scoped to tab A
 * must not resolve in tab B. The tests below pin that contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRefsForTab,
  getRef,
  isRef,
  newRef,
  refWatermark,
  resetRefsForTab,
} from '../src/tools/refs.js';

// Each test gets a clean slate — refs.ts uses module-level Maps.
beforeEach(() => {
  clearRefsForTab(1);
  clearRefsForTab(2);
  clearRefsForTab(5);
  clearRefsForTab(7);
});

describe('newRef', () => {
  it('returns sequential ids starting at e1', () => {
    expect(newRef(1, 100, 'button', 'Submit', 'L1')).toBe('e1');
    expect(newRef(1, 101, 'link', 'Home', 'L1')).toBe('e2');
    expect(newRef(1, 102, 'textbox', '', 'L1')).toBe('e3');
  });

  it('counts independently per tab', () => {
    expect(newRef(1, 100, 'button', 'A', 'L1')).toBe('e1');
    expect(newRef(2, 200, 'button', 'B', 'L1')).toBe('e1'); // independent counter
    expect(newRef(1, 101, 'button', 'A2', 'L1')).toBe('e2');
    expect(newRef(2, 201, 'button', 'B2', 'L1')).toBe('e2');
  });
});

describe('getRef', () => {
  it('finds refs by bare id (e1) and prefixed (@e1)', () => {
    newRef(1, 100, 'button', 'Go', 'L1');
    const a = getRef(1, 'e1');
    const b = getRef(1, '@e1');
    expect(a).toEqual({ backendDOMNodeId: 100, role: 'button', name: 'Go', loaderId: 'L1' });
    expect(b).toEqual(a);
  });

  it('returns null for an unknown ref', () => {
    newRef(1, 100, 'button', 'Go', 'L1');
    expect(getRef(1, 'e99')).toBeNull();
    expect(getRef(1, '@e99')).toBeNull();
  });

  it('isolates refs by tab — a ref on tab 1 does not resolve on tab 2', () => {
    newRef(1, 100, 'button', 'OnlyOnA', 'L1');
    expect(getRef(1, 'e1')).not.toBeNull();
    expect(getRef(2, 'e1')).toBeNull();
  });

  it('returns null for tabs with no refs', () => {
    expect(getRef(999, 'e1')).toBeNull();
  });
});

describe('document stamp', () => {
  it('stores the loader id each ref was minted under, per ref', () => {
    // Per REF, not per map: mouse_click's hitTargetRef is minted outside any
    // snapshot, possibly for a different document than the map's other refs.
    newRef(1, 100, 'button', 'Old', 'L1');
    newRef(1, 101, 'div', 'Overlay', 'L2');
    newRef(1, 102, 'button', 'Unknown', null);
    expect(getRef(1, 'e1')?.loaderId).toBe('L1');
    expect(getRef(1, 'e2')?.loaderId).toBe('L2');
    expect(getRef(1, 'e3')?.loaderId).toBeNull();
  });
});

describe('isRef', () => {
  it.each([
    ['e1', true],
    ['e42', true],
    ['@e1', true],
    ['@e9999', true],
    ['e', false],
    ['e1a', false],
    ['button', false],
    ['#submit', false],
    ['', false],
  ])('isRef(%s) === %s', (s, expected) => {
    expect(isRef(s)).toBe(expected);
  });
});

describe('clearRefsForTab / resetRefsForTab', () => {
  it('clearRefsForTab removes the tab entirely — counter is gone, new refs restart at e1', () => {
    newRef(1, 100, 'button', '', 'L1');
    newRef(1, 101, 'link', '', 'L1');
    expect(getRef(1, 'e2')).not.toBeNull();

    clearRefsForTab(1);
    expect(getRef(1, 'e1')).toBeNull();
    expect(getRef(1, 'e2')).toBeNull();

    // Re-adding starts the counter from scratch.
    expect(newRef(1, 200, 'button', '', 'L1')).toBe('e1');
  });

  it('resetRefsForTab wipes refs but keeps counting — ids never rebind', () => {
    // The whole point: after a re-snapshot of the SAME page, a ref the agent
    // still holds must MISS (→ bad_ref, recoverable) rather than resolve to
    // whatever element now occupies that slot.
    newRef(1, 100, 'button', '', 'L1');
    resetRefsForTab(1);
    expect(getRef(1, 'e1')).toBeNull();
    expect(newRef(1, 200, 'button', '', 'L1')).toBe('e2');
  });

  it('never reissues an id across repeated resets', () => {
    const seen = new Set<string>();
    for (let round = 0; round < 5; round += 1) {
      resetRefsForTab(1);
      for (let i = 0; i < 3; i += 1) {
        const id = newRef(1, 1000 + round * 10 + i, 'button', '', 'L1');
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(15);
  });

  it('clearRefsForTab restarts numbering — for a CLOSED tab, whose ids nobody can name', () => {
    newRef(1, 100, 'button', '', 'L1');
    newRef(1, 101, 'button', '', 'L1');
    clearRefsForTab(1);
    expect(newRef(1, 200, 'button', '', 'L1')).toBe('e1');
  });

  it('rewinds to a watermark, so a snapshot’s discarded internal passes cost no ids', () => {
    // buildSnapshotTree mints for the a11y attempt, discards it, re-mints for
    // the DOM cross-check. Only the surviving pass may advance the counter.
    expect(newRef(1, 100, 'button', '', 'L1')).toBe('e1');
    const mark = refWatermark(1);
    expect(mark).toBe(1);

    resetRefsForTab(1, mark); // start of the snapshot
    expect(newRef(1, 200, 'button', '', 'L1')).toBe('e2'); // a11y attempt
    resetRefsForTab(1, mark); // discarded — rewind
    expect(newRef(1, 300, 'button', '', 'L1')).toBe('e2'); // DOM pass reuses the number
    expect(getRef(1, 'e2')).toEqual({
      backendDOMNodeId: 300,
      role: 'button',
      name: '',
      loaderId: 'L1',
    });
    // …and the ref that was actually handed out earlier is still gone, not aliased.
    expect(getRef(1, 'e1')).toBeNull();
  });

  it('refWatermark is per tab and survives a reset', () => {
    newRef(1, 100, 'button', '', 'L1');
    newRef(1, 101, 'button', '', 'L1');
    expect(refWatermark(1)).toBe(2);
    expect(refWatermark(2)).toBe(0);
    resetRefsForTab(1);
    expect(refWatermark(1)).toBe(2);
    clearRefsForTab(1);
    expect(refWatermark(1)).toBe(0);
  });

  it('a reset for a tab with no refs leaves nothing behind', () => {
    // debugger.onDetach can land after tabs.onRemoved already cleared the tab.
    resetRefsForTab(5);
    expect(refWatermark(5)).toBe(0);
    expect(getRef(5, 'e1')).toBeNull();
    expect(newRef(5, 1, 'button', '', 'L1')).toBe('e1');
  });

  it('clearing one tab does not affect another', () => {
    newRef(1, 100, 'button', '', 'L1');
    newRef(2, 200, 'button', '', 'L1');
    clearRefsForTab(1);
    expect(getRef(1, 'e1')).toBeNull();
    expect(getRef(2, 'e1')).not.toBeNull();
  });
});
