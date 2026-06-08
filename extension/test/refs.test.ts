/**
 * Per-tab `@eN` ref map.
 *
 * The whole point of these refs is *isolation*: snapshot of tab A must
 * never invalidate or alias refs for tab B, and a ref scoped to tab A
 * must not resolve in tab B. The tests below pin that contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { clearRefsForTab, getRef, isRef, newRef, resetRefsForTab } from '../src/tools/refs.js';

// Each test gets a clean slate — refs.ts uses module-level Maps.
beforeEach(() => {
  clearRefsForTab(1);
  clearRefsForTab(2);
  clearRefsForTab(5);
  clearRefsForTab(7);
});

describe('newRef', () => {
  it('returns sequential ids starting at e1', () => {
    expect(newRef(1, 100, 'button', 'Submit')).toBe('e1');
    expect(newRef(1, 101, 'link', 'Home')).toBe('e2');
    expect(newRef(1, 102, 'textbox', '')).toBe('e3');
  });

  it('counts independently per tab', () => {
    expect(newRef(1, 100, 'button', 'A')).toBe('e1');
    expect(newRef(2, 200, 'button', 'B')).toBe('e1'); // independent counter
    expect(newRef(1, 101, 'button', 'A2')).toBe('e2');
    expect(newRef(2, 201, 'button', 'B2')).toBe('e2');
  });
});

describe('getRef', () => {
  it('finds refs by bare id (e1) and prefixed (@e1)', () => {
    newRef(1, 100, 'button', 'Go');
    const a = getRef(1, 'e1');
    const b = getRef(1, '@e1');
    expect(a).toEqual({ backendDOMNodeId: 100, role: 'button', name: 'Go' });
    expect(b).toEqual(a);
  });

  it('returns null for an unknown ref', () => {
    newRef(1, 100, 'button', 'Go');
    expect(getRef(1, 'e99')).toBeNull();
    expect(getRef(1, '@e99')).toBeNull();
  });

  it('isolates refs by tab — a ref on tab 1 does not resolve on tab 2', () => {
    newRef(1, 100, 'button', 'OnlyOnA');
    expect(getRef(1, 'e1')).not.toBeNull();
    expect(getRef(2, 'e1')).toBeNull();
  });

  it('returns null for tabs with no refs', () => {
    expect(getRef(999, 'e1')).toBeNull();
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
    newRef(1, 100, 'button', '');
    newRef(1, 101, 'link', '');
    expect(getRef(1, 'e2')).not.toBeNull();

    clearRefsForTab(1);
    expect(getRef(1, 'e1')).toBeNull();
    expect(getRef(1, 'e2')).toBeNull();

    // Re-adding starts the counter from scratch.
    expect(newRef(1, 200, 'button', '')).toBe('e1');
  });

  it('resetRefsForTab wipes refs but otherwise behaves like clear', () => {
    newRef(1, 100, 'button', '');
    resetRefsForTab(1);
    expect(getRef(1, 'e1')).toBeNull();
    expect(newRef(1, 200, 'button', '')).toBe('e1');
  });

  it('clearing one tab does not affect another', () => {
    newRef(1, 100, 'button', '');
    newRef(2, 200, 'button', '');
    clearRefsForTab(1);
    expect(getRef(1, 'e1')).toBeNull();
    expect(getRef(2, 'e1')).not.toBeNull();
  });
});
