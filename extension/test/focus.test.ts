/**
 * Focus traversal behind the keystroke password gate (key_type / send_keys).
 *
 * `findActiveField` is the source of the in-page probe string in
 * `keyboard.ts` (serialised via toString). keyboard.ts is chrome-bound and
 * can't load under vitest, so the security-relevant logic — "descend OPEN
 * shadow roots to the real focused field" — is tested here against mock DOM
 * shapes. A regression in the traversal would otherwise ship silently.
 */

import { describe, expect, it } from 'vitest';
import { classifyPasswordProbe, findActiveField, type FocusNode } from '../src/tools/focus.js';

function input(type: string): FocusNode {
  return { tagName: 'INPUT', type };
}

describe('findActiveField — keystroke password-gate focus traversal', () => {
  it('reads a plain focused input (no shadow DOM)', () => {
    expect(findActiveField({ activeElement: input('password') })).toEqual({
      tag: 'INPUT',
      type: 'password',
    });
    expect(findActiveField({ activeElement: input('text') })).toEqual({
      tag: 'INPUT',
      type: 'text',
    });
  });

  it('descends a single OPEN shadow root to the real field (the bypass fix)', () => {
    // document.activeElement is the host; the inner password must still be seen.
    const host: FocusNode = {
      tagName: 'MY-LOGIN',
      shadowRoot: { activeElement: input('password') },
    };
    expect(findActiveField({ activeElement: host })).toEqual({ tag: 'INPUT', type: 'password' });
  });

  it('descends NESTED open shadow roots to the deepest field', () => {
    const inner: FocusNode = { tagName: 'INNER', shadowRoot: { activeElement: input('password') } };
    const outer: FocusNode = { tagName: 'OUTER', shadowRoot: { activeElement: inner } };
    expect(findActiveField({ activeElement: outer })).toEqual({ tag: 'INPUT', type: 'password' });
  });

  it('stops at a CLOSED root (shadowRoot null) — the documented blind spot', () => {
    // Page script sees shadowRoot === null for mode:'closed'; the probe can
    // only report the host, which is not an INPUT, so the gate would pass.
    const closedHost: FocusNode = { tagName: 'MY-CLOSED', shadowRoot: null };
    expect(findActiveField({ activeElement: closedHost })).toEqual({ tag: 'MY-CLOSED', type: '' });
  });

  it('reports an open host with nothing focused inside as the host', () => {
    const host: FocusNode = { tagName: 'MY-EMPTY', shadowRoot: { activeElement: null } };
    expect(findActiveField({ activeElement: host })).toEqual({ tag: 'MY-EMPTY', type: '' });
  });

  it('handles no focus / nothing focused', () => {
    expect(findActiveField({})).toEqual({ tag: '', type: '' });
    expect(findActiveField({ activeElement: null })).toEqual({ tag: '', type: '' });
  });

  it('lowercases the type so the gate comparison is case-insensitive', () => {
    expect(findActiveField({ activeElement: input('PASSWORD') }).type).toBe('password');
  });
});

describe('classifyPasswordProbe — fail-closed decision for the CDP probe result', () => {
  it('lets a clean non-password result through', () => {
    expect(classifyPasswordProbe({ value: { tag: 'INPUT', type: 'text' } }, false)).toEqual({
      blocked: false,
    });
    expect(classifyPasswordProbe({ value: { tag: '', type: '' } }, false)).toEqual({
      blocked: false,
    });
  });

  it('blocks with password_field on an actual password input', () => {
    const out = classifyPasswordProbe({ value: { tag: 'INPUT', type: 'password' } }, false);
    expect(out).toMatchObject({ blocked: true, code: 'password_field' });
  });

  it('fails closed with focus_probe_failed when the probe threw (hostile getter)', () => {
    // Runtime.evaluate reports exceptionDetails; returnByValue yields no `value`.
    const out = classifyPasswordProbe({ value: undefined }, true);
    expect(out).toMatchObject({ blocked: true, code: 'focus_probe_failed' });
  });

  it('fails closed with focus_probe_failed on a missing value even without an exception', () => {
    // Belt-and-braces: an unreadable/undefined value must never read as "safe".
    const out = classifyPasswordProbe({ value: undefined }, false);
    expect(out).toMatchObject({ blocked: true, code: 'focus_probe_failed' });
  });

  it('never suggests allowPassword for a probe failure (that would be misleading)', () => {
    const out = classifyPasswordProbe({ value: undefined }, true);
    expect(out).toMatchObject({ blocked: true });
    if (out.blocked) expect(out.reason.toLowerCase()).not.toContain('allowpassword');
  });
});
