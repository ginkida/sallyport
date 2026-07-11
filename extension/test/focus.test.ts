/** Pure response parsing behind the CDP-level keystroke password gate. */

import { describe, expect, it } from 'vitest';
import { collectFrameIds, domNodeIsPassword, focusedBackendNodeIds } from '../src/tools/focus.js';

const focused = (backendDOMNodeId?: number): Record<string, unknown> => ({
  ...(backendDOMNodeId === undefined ? {} : { backendDOMNodeId }),
  properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
});

describe('collectFrameIds', () => {
  it('walks nested same-origin and cross-origin frame descriptors', () => {
    expect(
      collectFrameIds({
        frame: { id: 'top' },
        childFrames: [
          { frame: { id: 'a' } },
          { frame: { id: 'b' }, childFrames: [{ frame: { id: 'b-child' } }] },
        ],
      }),
    ).toEqual(['top', 'a', 'b', 'b-child']);
  });

  it('fails closed on a missing id or malformed children collection', () => {
    expect(collectFrameIds({ frame: {} })).toBeNull();
    expect(collectFrameIds({ frame: { id: 'top' }, childFrames: {} })).toBeNull();
    expect(
      collectFrameIds({ frame: { id: 'top' }, childFrames: [{ frame: { id: 7 } }] }),
    ).toBeNull();
  });
});

describe('focusedBackendNodeIds', () => {
  it('extracts and de-duplicates focused backend nodes', () => {
    expect(
      focusedBackendNodeIds([{ backendDOMNodeId: 1, properties: [] }, focused(42), focused(42)]),
    ).toEqual([42]);
  });

  it('returns an empty list for a valid frame that does not own focus', () => {
    expect(focusedBackendNodeIds([{ backendDOMNodeId: 1, properties: [] }])).toEqual([]);
  });

  it('fails closed when a focused AX node has no usable backend id', () => {
    expect(focusedBackendNodeIds([focused()])).toBeNull();
    expect(focusedBackendNodeIds([focused(-1)])).toBeNull();
    expect(focusedBackendNodeIds([focused(1.5)])).toBeNull();
  });

  it('fails closed on malformed AX payloads', () => {
    expect(focusedBackendNodeIds(undefined)).toBeNull();
    expect(focusedBackendNodeIds([null])).toBeNull();
    expect(focusedBackendNodeIds([{ properties: {} }])).toBeNull();
    expect(focusedBackendNodeIds([{ properties: [null] }])).toBeNull();
    expect(focusedBackendNodeIds([{ properties: [{ name: 'focused' }] }])).toBeNull();
  });
});

describe('domNodeIsPassword', () => {
  it('recognises password inputs case-insensitively from browser attributes', () => {
    expect(domNodeIsPassword({ nodeName: 'INPUT', attributes: ['type', 'password'] })).toBe(true);
    expect(domNodeIsPassword({ nodeName: 'input', attributes: ['TYPE', ' PASSWORD '] })).toBe(true);
  });

  it('allows well-formed ordinary inputs and non-input nodes', () => {
    expect(domNodeIsPassword({ nodeName: 'INPUT', attributes: ['type', 'email'] })).toBe(false);
    expect(domNodeIsPassword({ nodeName: 'INPUT', attributes: [] })).toBe(false);
    expect(domNodeIsPassword({ nodeName: '#document' })).toBe(false);
    expect(domNodeIsPassword({ nodeName: 'IFRAME', attributes: ['src', 'https://x.test'] })).toBe(
      false,
    );
  });

  it('fails closed on malformed or unreadable DOM descriptions', () => {
    expect(domNodeIsPassword(undefined)).toBeNull();
    expect(domNodeIsPassword({ nodeName: 7, attributes: [] })).toBeNull();
    expect(domNodeIsPassword({ nodeName: 'INPUT' })).toBeNull();
    expect(domNodeIsPassword({ nodeName: 'INPUT', attributes: ['type', 7] })).toBeNull();
  });
});
