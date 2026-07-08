import { describe, expect, it } from 'vitest';

import {
  decideDialogResponse,
  defaultDialogResponse,
  describeArmed,
  DIALOG_MAX_ENTRIES,
  DIALOG_MAX_MESSAGE,
  DIALOG_MAX_PROMPT_TEXT,
  filterDialogEntries,
  parseDialogArgs,
  shapeDialogEntry,
  type DialogEntry,
} from '../src/tools/dialog-capture.js';
import { BridgeError } from '../src/tools/errors.js';

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
    expect(decideDialogResponse(undefined, 'confirm')).toEqual({
      response: { accept: false },
      armed: false,
    });
    expect(decideDialogResponse(undefined, 'alert')).toEqual({
      response: { accept: true },
      armed: false,
    });
  });

  it('an armed accept/dismiss overrides the default', () => {
    expect(decideDialogResponse({ accept: true }, 'confirm')).toEqual({
      response: { accept: true },
      armed: true,
    });
    expect(decideDialogResponse({ accept: true }, 'beforeunload')).toEqual({
      response: { accept: true },
      armed: true,
    });
  });

  it('honours promptText only on an ACCEPTED prompt()', () => {
    expect(decideDialogResponse({ accept: true, promptText: 'hi' }, 'prompt')).toEqual({
      response: { accept: true, promptText: 'hi' },
      armed: true,
    });
  });

  it('drops promptText on non-prompt types and on a dismiss', () => {
    expect(decideDialogResponse({ accept: true, promptText: 'hi' }, 'confirm')).toEqual({
      response: { accept: true },
      armed: true,
    });
    expect(decideDialogResponse({ accept: false, promptText: 'hi' }, 'prompt')).toEqual({
      response: { accept: false },
      armed: true,
    });
  });

  it('forces accept on an alert even when a dismiss is armed', () => {
    expect(decideDialogResponse({ accept: false }, 'alert')).toEqual({
      response: { accept: true },
      armed: true,
    });
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

describe('filterDialogEntries', () => {
  const mk = (origin: string | null): DialogEntry => ({
    ts: 1,
    type: 'confirm',
    message: 'm',
    origin,
    response: { accept: false },
    armed: false,
  });

  it('keeps allowed origins, drops others', () => {
    const out = filterDialogEntries(
      [mk('https://ok.example'), mk('https://evil.example')],
      (o) => o === 'https://ok.example',
    );
    expect(out).toHaveLength(1);
    expect(out[0].origin).toBe('https://ok.example');
  });

  it('fail-closed: a null origin is dropped even if the check would pass', () => {
    expect(filterDialogEntries([mk(null)], () => true)).toEqual([]);
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
