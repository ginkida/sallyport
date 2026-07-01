import { describe, expect, it } from 'vitest';

import { isFocusMovingKey } from '../src/tools/keyboard.js';

// The password gate on send_keys must re-probe after any segment that can move
// focus, so a `tab secret` sequence can't land the credential in a password
// field the one-shot up-front probe never saw (invariant #5). isFocusMovingKey
// decides where those focus boundaries are.
describe('isFocusMovingKey', () => {
  it('flags focus-moving keys (bare and modified)', () => {
    for (const k of [
      'tab',
      'Tab',
      'enter',
      'return',
      'ArrowUp',
      'arrowdown',
      'arrowleft',
      'ArrowRight',
      'home',
      'End',
      'pageup',
      'pagedown',
      'shift+tab', // Shift+Tab still moves focus (backwards)
    ]) {
      expect(isFocusMovingKey(k)).toBe(true);
    }
  });

  it('does not flag text/character or shortcut segments', () => {
    for (const k of ['s', 'A', '5', 'space', 'escape', 'backspace', 'delete', 'mod+a', 'ctrl+c']) {
      expect(isFocusMovingKey(k)).toBe(false);
    }
  });

  it('keys on the TERMINAL key of a chord, not a modifier', () => {
    // The last '+'-part is the key; modifiers before it don't count.
    expect(isFocusMovingKey('ctrl+shift+tab')).toBe(true);
    expect(isFocusMovingKey('ctrl+tab')).toBe(true);
    expect(isFocusMovingKey('tab+a')).toBe(false); // terminal key is 'a'
  });

  it('is empty/whitespace-safe', () => {
    expect(isFocusMovingKey('')).toBe(false);
    expect(isFocusMovingKey('+')).toBe(false);
    expect(isFocusMovingKey('  tab  ')).toBe(true);
  });
});
