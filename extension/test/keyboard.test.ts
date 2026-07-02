import { describe, expect, it } from 'vitest';

import { segmentTypesText } from '../src/tools/keyboard.js';

// The password gate on send_keys re-probes before every character-typing segment
// (after the first), so a `<focus-mover> secret` sequence can't land the
// credential in a password field the one-shot up-front probe never saw
// (invariant #5). segmentTypesText decides which segments deposit a character —
// deliberately NOT an enumeration of focus-movers, because Space/Enter activate
// the focused control and site JS can .focus() on any key.
describe('segmentTypesText', () => {
  it('is true for keys that deposit a character', () => {
    // letters, digits, space, enter/return all resolve to `text`.
    for (const k of ['s', 'A', '5', 'space', 'Space', 'enter', 'return', 'shift+a', 'shift+5']) {
      expect(segmentTypesText(k)).toBe(true);
    }
  });

  it('is false for navigation/edit keys that move focus or edit but type no char', () => {
    for (const k of [
      'tab',
      'Tab',
      'shift+tab',
      'escape',
      'esc',
      'backspace',
      'delete',
      'arrowup',
      'ArrowDown',
      'home',
      'end',
      'pageup',
      'pagedown',
      'f5',
    ]) {
      expect(segmentTypesText(k)).toBe(false);
    }
  });

  it('is false for command chords (a non-shift modifier is a command, not text)', () => {
    for (const k of ['mod+a', 'ctrl+c', 'cmd+v', 'alt+a', 'ctrl+shift+tab', 'ctrl+shift+a']) {
      expect(segmentTypesText(k)).toBe(false);
    }
  });

  it('resolves on the TERMINAL key of a chord', () => {
    expect(segmentTypesText('shift+a')).toBe(true); // shift is allowed; 'a' types
    expect(segmentTypesText('tab+a')).toBe(false); // 'tab' in a modifier slot => command
  });

  it('is empty/whitespace/unknown-key safe (fails closed to false)', () => {
    expect(segmentTypesText('')).toBe(false);
    expect(segmentTypesText('+')).toBe(false);
    expect(segmentTypesText('  s  ')).toBe(true);
    expect(segmentTypesText('  tab  ')).toBe(false);
    expect(segmentTypesText('notarealkey')).toBe(false); // resolveKey throws -> false
  });
});
