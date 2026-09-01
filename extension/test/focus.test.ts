/** Pure response parsing behind the CDP-level keystroke password gate. */

import { describe, expect, it } from 'vitest';
import {
  collectFrameIds,
  domNodeAcceptsText,
  domNodeIsPassword,
  focusedBackendNodeIds,
} from '../src/tools/focus.js';

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

describe('domNodeAcceptsText — can Input.insertText land here at all?', () => {
  const node = (nodeName: string, attributes: string[] = []) => ({ nodeName, attributes });

  it('accepts the ordinary text targets', () => {
    expect(domNodeAcceptsText(node('TEXTAREA'))).toBe(true);
    expect(domNodeAcceptsText(node('INPUT', ['type', 'text']))).toBe(true);
    expect(domNodeAcceptsText(node('INPUT', ['type', 'search']))).toBe(true);
    expect(domNodeAcceptsText(node('INPUT', []))).toBe(true); // no type = text
  });

  it('accepts a contenteditable host — every rich composer is one', () => {
    expect(domNodeAcceptsText(node('DIV', ['contenteditable', 'true']))).toBe(true);
    expect(domNodeAcceptsText(node('DIV', ['contenteditable', '']))).toBe(true); // "" means true
    expect(domNodeAcceptsText(node('DIV', ['contenteditable', 'false']))).toBe(false);
  });

  it('refuses what an insert cannot reach', () => {
    // The common case: after a navigate nothing is focused, so focus sits on
    // <body> — not a password field, so the password gate waved it through
    // while the insert went nowhere and the tool answered ok:true.
    expect(domNodeAcceptsText(node('BODY'))).toBe(false);
    expect(domNodeAcceptsText(node('INPUT', ['type', 'checkbox']))).toBe(false);
    expect(domNodeAcceptsText(node('INPUT', ['type', 'file']))).toBe(false);
    expect(domNodeAcceptsText(node('INPUT', ['type', 'submit']))).toBe(false);
    // A div with a key handler receives NOTHING from insertText (no key events
    // are dispatched), so refusing it is correct, not merely cautious.
    expect(domNodeAcceptsText(node('DIV', ['tabindex', '0']))).toBe(false);
  });

  it('lets an unusual input type try rather than refusing a call that would work', () => {
    expect(domNodeAcceptsText(node('INPUT', ['type', 'date']))).toBe(true);
    expect(domNodeAcceptsText(node('INPUT', ['type', 'number']))).toBe(true);
  });

  it('is unclassifiable rather than false on a malformed node', () => {
    // Fail-closed, same convention as domNodeIsPassword: the caller turns this
    // into focus_probe_failed rather than guessing.
    expect(domNodeAcceptsText(null)).toBeNull();
    expect(domNodeAcceptsText({})).toBeNull();
    expect(domNodeAcceptsText({ nodeName: 'INPUT', attributes: 'nope' })).toBeNull();
    expect(domNodeAcceptsText({ nodeName: 'INPUT' })).toBeNull();
    expect(domNodeAcceptsText({ nodeName: 'INPUT', attributes: ['type', 5] })).toBeNull();
  });
});
