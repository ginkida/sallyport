import { describe, expect, it } from 'vitest';

import { parsePointerTarget } from '../src/tools/mouse.js';

describe('parsePointerTarget (mouse_click / hover)', () => {
  it('selector mode passes the selector through', () => {
    expect(parsePointerTarget({ selector: '@e3' }, 'hover')).toEqual({
      mode: 'selector',
      selector: '@e3',
    });
  });

  it('coord mode parses x/y', () => {
    expect(parsePointerTarget({ x: 10, y: 20 }, 'hover')).toEqual({ mode: 'coord', x: 10, y: 20 });
  });

  it('requires x and y together', () => {
    expect(() => parsePointerTarget({ x: 10 }, 'mouse_click')).toThrowError(
      /mouse_click: x and y must be given together/,
    );
    expect(() => parsePointerTarget({ y: 20 }, 'hover')).toThrowError(
      /hover: x and y must be given together/,
    );
  });

  it('rejects selector and coords together', () => {
    expect(() => parsePointerTarget({ selector: '.x', x: 1, y: 2 }, 'mouse_click')).toThrowError(
      /pass either selector or x\/y, not both/,
    );
  });

  it('requires at least one target', () => {
    expect(() => parsePointerTarget({}, 'hover')).toThrowError(/hover: selector or x\/y required/);
  });

  it('rejects negative or non-finite coords', () => {
    expect(() => parsePointerTarget({ x: -1, y: 2 }, 'hover')).toThrowError(
      /x must be a non-negative number/,
    );
    expect(() => parsePointerTarget({ x: 1, y: NaN }, 'hover')).toThrowError(
      /y must be a non-negative number/,
    );
  });

  it('names the calling tool in every error (shared helper, distinct messages)', () => {
    expect(() => parsePointerTarget({}, 'mouse_click')).toThrowError(/mouse_click:/);
    expect(() => parsePointerTarget({}, 'hover')).toThrowError(/hover:/);
  });

  it('treats an empty selector string as absent', () => {
    expect(() => parsePointerTarget({ selector: '' }, 'hover')).toThrowError(/selector or x\/y/);
  });
});
