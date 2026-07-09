import { describe, expect, it } from 'vitest';

import {
  decideDialogResponse,
  defaultDialogResponse,
  describeArmed,
  DIALOG_MAX_ENTRIES,
  DIALOG_MAX_MESSAGE,
  DIALOG_MAX_PROMPT_TEXT,
  parseDialogArgs,
  shapeDialogEntry,
} from '../src/tools/dialog-capture.js';
import { BridgeError } from '../src/tools/errors.js';

const ORIGIN = 'https://app.example.com';
const OTHER_ORIGIN = 'https://evil.example';

describe('defaultDialogResponse', () => {
  it('accepts only alert — OK is its sole button', () => {
    expect(defaultDialogResponse('alert')).toEqual({ accept: true });
  });

  it('dismisses confirm/prompt/beforeunload (safe cancel)', () => {
    expect(defaultDialogResponse('confirm')).toEqual({ accept: false });
    expect(defaultDialogResponse('prompt')).toEqual({ accept: false });
    expect(defaultDialogResponse('beforeunload')).toEqual({ accept: false });
  });

  it('dismisses an unknown future dialog type (fail-safe bucket)', () => {
    expect(defaultDialogResponse('modal-v2')).toEqual({ accept: false });
    expect(defaultDialogResponse('')).toEqual({ accept: false });
  });
});

describe('decideDialogResponse', () => {
  it('falls back to the default policy when nothing is armed', () => {
    expect(decideDialogResponse(undefined, 'confirm', ORIGIN)).toEqual({
      response: { accept: false },
      armed: false,
    });
    expect(decideDialogResponse(undefined, 'alert', ORIGIN)).toEqual({
      response: { accept: true },
      armed: false,
    });
  });

  it('an armed accept/dismiss overrides the default when the origin matches', () => {
    expect(
      decideDialogResponse({ response: { accept: true }, origin: ORIGIN }, 'confirm', ORIGIN),
    ).toEqual({ response: { accept: true }, armed: true });
    expect(
      decideDialogResponse({ response: { accept: true }, origin: ORIGIN }, 'beforeunload', ORIGIN),
    ).toEqual({ response: { accept: true }, armed: true });
  });

  it('honours promptText only on an ACCEPTED prompt() from the armed origin', () => {
    expect(
      decideDialogResponse(
        { response: { accept: true, promptText: 'hi' }, origin: ORIGIN },
        'prompt',
        ORIGIN,
      ),
    ).toEqual({ response: { accept: true, promptText: 'hi' }, armed: true });
  });

  it('drops promptText on non-prompt types and on a dismiss', () => {
    expect(
      decideDialogResponse(
        { response: { accept: true, promptText: 'hi' }, origin: ORIGIN },
        'confirm',
        ORIGIN,
      ),
    ).toEqual({ response: { accept: true }, armed: true });
    expect(
      decideDialogResponse(
        { response: { accept: false, promptText: 'hi' }, origin: ORIGIN },
        'prompt',
        ORIGIN,
      ),
    ).toEqual({ response: { accept: false }, armed: true });
  });

  it('forces accept on an alert from the armed origin even when a dismiss is armed', () => {
    expect(
      decideDialogResponse({ response: { accept: false }, origin: ORIGIN }, 'alert', ORIGIN),
    ).toEqual({ response: { accept: true }, armed: true });
  });

  it('SECURITY: an origin mismatch falls through to the default and does NOT consume the arm', () => {
    // A dialog from a DIFFERENT origin than the one the arm was checked
    // against (e.g. a cross-origin iframe, or the tab having navigated
    // elsewhere) must not receive the escalated response.
    expect(
      decideDialogResponse(
        { response: { accept: true, promptText: 'secret' }, origin: ORIGIN },
        'prompt',
        OTHER_ORIGIN,
      ),
    ).toEqual({ response: { accept: false }, armed: false });
  });

  it('SECURITY: fail-closed — an unresolvable dialog origin never matches, even an unresolvable armed origin', () => {
    expect(
      decideDialogResponse({ response: { accept: true }, origin: ORIGIN }, 'confirm', null),
    ).toEqual({ response: { accept: false }, armed: false });
    expect(
      decideDialogResponse({ response: { accept: true }, origin: null }, 'confirm', null),
    ).toEqual({ response: { accept: false }, armed: false });
  });

  it('an alert from a mismatched origin still resolves to accept via the DEFAULT policy, not the arm', () => {
    const result = decideDialogResponse(
      { response: { accept: false }, origin: ORIGIN },
      'alert',
      OTHER_ORIGIN,
    );
    expect(result).toEqual({ response: { accept: true }, armed: false });
  });
});

describe('shapeDialogEntry', () => {
  it('records type, capped message, origin and the response given', () => {
    const entry = shapeDialogEntry(
      { type: 'confirm', message: 'Delete?', url: 'https://app.example.com/settings' },
      { accept: false },
      false,
      1234,
    );
    expect(entry).toEqual({
      ts: 1234,
      type: 'confirm',
      message: 'Delete?',
      origin: 'https://app.example.com',
      response: { accept: false },
      armed: false,
    });
  });

  it('caps the (page-controlled) message text', () => {
    const entry = shapeDialogEntry(
      { type: 'alert', message: 'x'.repeat(DIALOG_MAX_MESSAGE + 100), url: 'https://a.example' },
      { accept: true },
      false,
      1,
    );
    expect(entry.message).toHaveLength(DIALOG_MAX_MESSAGE);
  });

  it('tolerates missing/odd fields and marks unknowable origins null', () => {
    const entry = shapeDialogEntry({}, { accept: false }, true, 7);
    expect(entry).toEqual({
      ts: 7,
      type: '',
      message: '',
      origin: null,
      response: { accept: false },
      armed: true,
    });
    expect(shapeDialogEntry({ url: 'about:blank' }, { accept: false }, false, 7).origin).toBeNull();
  });
});

describe('parseDialogArgs', () => {
  it('defaults to read-only with the full ring', () => {
    expect(parseDialogArgs({})).toEqual({ limit: DIALOG_MAX_ENTRIES });
  });

  it('parses an armed accept with promptText', () => {
    expect(parseDialogArgs({ action: 'accept', promptText: 'name' })).toEqual({
      action: 'accept',
      promptText: 'name',
      limit: DIALOG_MAX_ENTRIES,
    });
  });

  it('parses a dismiss and a custom limit (capped at the ring size)', () => {
    expect(parseDialogArgs({ action: 'dismiss', limit: 5 })).toEqual({
      action: 'dismiss',
      limit: 5,
    });
    expect(parseDialogArgs({ limit: 999 }).limit).toBe(DIALOG_MAX_ENTRIES);
  });

  it('rejects an unknown action', () => {
    expect(() => parseDialogArgs({ action: 'ok' })).toThrowError(BridgeError);
    expect(() => parseDialogArgs({ action: 42 })).toThrowError(/action/);
  });

  it('rejects promptText without accept, non-string, or oversized', () => {
    expect(() => parseDialogArgs({ promptText: 'x' })).toThrowError(/accept/);
    expect(() => parseDialogArgs({ action: 'dismiss', promptText: 'x' })).toThrowError(/accept/);
    expect(() => parseDialogArgs({ action: 'accept', promptText: 42 })).toThrowError(/string/);
    expect(() =>
      parseDialogArgs({ action: 'accept', promptText: 'x'.repeat(DIALOG_MAX_PROMPT_TEXT + 1) }),
    ).toThrowError(/too long/);
  });

  it('rejects a bad limit', () => {
    expect(() => parseDialogArgs({ limit: 0 })).toThrowError(BridgeError);
    expect(() => parseDialogArgs({ limit: -1 })).toThrowError(BridgeError);
    expect(() => parseDialogArgs({ limit: 1.5 })).toThrowError(BridgeError);
    expect(() => parseDialogArgs({ limit: 'many' })).toThrowError(BridgeError);
  });
});

describe('describeArmed', () => {
  it('mirrors the armed one-shot back as action strings', () => {
    expect(describeArmed(undefined)).toBeNull();
    expect(describeArmed({ accept: false })).toEqual({ action: 'dismiss' });
    expect(describeArmed({ accept: true, promptText: 't' })).toEqual({
      action: 'accept',
      promptText: 't',
    });
  });
});
