/**
 * Page-text cutting, in the leaf module both `read_text` and `observe` use.
 *
 * It lives on its own precisely because it was once duplicated: `observe`
 * shipped with a raw `slice`, and a lone surrogate reaching the signer discards
 * the ENTIRE tool_result — telling the agent an action that DID happen had
 * failed. Pure, so all of this is testable without chrome.
 */

import { describe, expect, it } from 'vitest';

import { capText, parseMaxChars, parseOffset } from '../src/tools/text.js';

/**
 * read_text's window. The cut was always REPORTED but never resumable: reading
 * past character 20 000 meant re-reading from zero with a bigger cap, paying
 * for the same characters twice and leaving both copies in the context.
 */
describe('capText / parseMaxChars / parseOffset (read_text)', () => {
  const text = 'abcdefghij'; // 10 chars

  it('returns the whole thing untouched when it fits', () => {
    expect(capText(text, 100)).toEqual({ text });
  });

  it('marks a cut and hands back where to continue', () => {
    expect(capText(text, 4)).toEqual({
      text: 'abcd',
      truncated: true,
      totalChars: 10,
      nextOffset: 4,
    });
  });

  it('nextOffset walks the whole string exactly once, with no overlap or gap', () => {
    let offset = 0;
    let assembled = '';
    for (let guard = 0; guard < 10; guard += 1) {
      const page = capText(text, 3, offset);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    expect(assembled).toBe(text);
  });

  it('reports the total on the final continuation page, so "done" is distinguishable', () => {
    const last = capText(text, 5, 5);
    expect(last).toEqual({ text: 'fghij', offset: 5, totalChars: 10 });
    expect(last.truncated).toBeUndefined();
  });

  it('an offset past the end is empty, not an error — a poll loop must not throw', () => {
    expect(capText(text, 5, 999)).toEqual({ text: '', offset: 10, totalChars: 10 });
  });

  it('never splits a surrogate pair — a lone half is unsignable (protocol.ts) and fails the whole read', () => {
    const emoji = '\u{1F600}'; // 2 UTF-16 code units
    const t = `ab${emoji}cd`; // length 6
    // maxChars 3 would cut between the pair's halves; the cut moves back.
    const page = capText(t, 3);
    expect(page.text).toBe('ab');
    expect(page.nextOffset).toBe(2);
    // Resuming from there yields the whole emoji, never an orphan half.
    const rest = capText(t, 3, page.nextOffset!);
    expect(rest.text).toBe(`${emoji}c`);
    expect(page.text + rest.text).toBe('ab' + emoji + 'c');
    for (const s of [page.text, rest.text]) {
      expect([...s].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(
        true,
      );
    }
  });

  it('takes a whole pair rather than emitting an empty page a paging loop would spin on', () => {
    const t = `\u{1F600}tail`;
    const page = capText(t, 1);
    expect(page.text).toBe('\u{1F600}');
    expect(page.nextOffset).toBe(2);
  });

  it('steps past an orphaned low surrogate when the caller resumes mid-pair', () => {
    const t = `ab\u{1F600}cd`;
    // offset 3 lands INSIDE the pair — an invented or stale offset.
    const page = capText(t, 10, 3);
    expect(page.text).toBe('cd');
    expect(page.offset).toBe(4);
  });

  it('reassembles an emoji-dense string exactly, one code unit at a time', () => {
    const t = '🙂a🙃b😀c';
    let offset = 0;
    let assembled = '';
    for (let guard = 0; guard < 50; guard += 1) {
      const page = capText(t, 1, offset);
      assembled += page.text;
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(assembled).toBe(t);
  });

  it('caps maxChars so one call cannot dump an unbounded page into the context', () => {
    expect(parseMaxChars(undefined)).toBe(20_000);
    expect(parseMaxChars(500)).toBe(500);
    expect(parseMaxChars(500_000)).toBe(200_000);
    expect(() => parseMaxChars(0)).toThrowError(/maxChars/);
    expect(() => parseMaxChars(-1)).toThrowError(/maxChars/);
    expect(() => parseMaxChars(1.5)).toThrowError(/maxChars/);
  });

  it('validates offset without coercing nonsense to 0', () => {
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset(0)).toBe(0);
    expect(parseOffset(4000)).toBe(4000);
    expect(() => parseOffset(-1)).toThrowError(/offset/);
    expect(() => parseOffset(2.5)).toThrowError(/offset/);
    expect(() => parseOffset('lots')).toThrowError(/offset/);
  });
});
