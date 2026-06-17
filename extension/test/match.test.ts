import { describe, expect, it } from 'vitest';

import type { CompactElement } from '../src/tools/axtree.js';
import { matchElements, parsePredicate } from '../src/tools/match.js';

const el = (ref: string, role: string, name?: string, value?: unknown): CompactElement => ({
  ref,
  role,
  ...(name !== undefined ? { name } : {}),
  ...(value !== undefined ? { value } : {}),
});

describe('parsePredicate', () => {
  it('normalises a string role to a one-element array', () => {
    expect(parsePredicate({ role: 'button' }, 'find')).toEqual({
      role: ['button'],
      nameExact: false,
    });
  });

  it('accepts an array of roles (one-of) and drops empties', () => {
    expect(parsePredicate({ role: ['button', '', 'link'] }, 'find').role).toEqual([
      'button',
      'link',
    ]);
  });

  it('carries name, value and nameExact', () => {
    expect(parsePredicate({ name: 'Send', value: 'hi', nameExact: true }, 'find')).toEqual({
      name: 'Send',
      value: 'hi',
      nameExact: true,
    });
  });

  it('treats empty strings as missing', () => {
    expect(() => parsePredicate({ name: '', role: '' }, 'find')).toThrowError(
      /need at least one of role, name, value/,
    );
  });

  it('rejects a predicate with no usable field', () => {
    expect(() => parsePredicate({ nameExact: true }, 'find')).toThrowError(
      /find: need at least one of role, name, value/,
    );
  });

  it('rejects malformed role / name / value with the tool name', () => {
    expect(() => parsePredicate({ role: 7 }, 'reveal')).toThrowError(/reveal: role must be/);
    expect(() => parsePredicate({ role: ['ok', 5] }, 'find')).toThrowError(/role must be/);
    expect(() => parsePredicate({ name: 7 }, 'find')).toThrowError(/name must be a string/);
    expect(() => parsePredicate({ value: {} }, 'find')).toThrowError(/value must be a string/);
  });
});

describe('matchElements', () => {
  const els = [
    el('@e1', 'button', 'Send'),
    el('@e2', 'button', 'Send a message'),
    el('@e3', 'link', 'Send feedback'),
    el('@e4', 'textbox', 'Message', ''),
    el('@e5', 'button'), // no name
  ];

  it('filters by exact role', () => {
    expect(matchElements(els, parsePredicate({ role: 'link' }, 'find')).map((m) => m.ref)).toEqual([
      '@e3',
    ]);
  });

  it('filters by one-of roles', () => {
    expect(
      matchElements(els, parsePredicate({ role: ['link', 'textbox'] }, 'find')).map((m) => m.ref),
    ).toEqual(['@e3', '@e4']);
  });

  it('name is a case-insensitive substring by default (matches the whole set)', () => {
    const refs = matchElements(els, parsePredicate({ name: 'send' }, 'find')).map((m) => m.ref);
    expect([...refs].sort()).toEqual(['@e1', '@e2', '@e3']);
  });

  it('ranks exact name over prefix, then shorter name wins among equal-relevance prefixes', () => {
    const ranked = matchElements(els, parsePredicate({ name: 'Send' }, 'find'));
    // @e1 "Send" exact (100). @e2 "Send a message" (14) and @e3 "Send feedback" (13) are both
    // prefixes (50); the shorter label @e3 ranks ahead of @e2.
    expect(ranked.map((m) => m.ref)).toEqual(['@e1', '@e3', '@e2']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('nameExact requires an exact (case-insensitive) match', () => {
    expect(
      matchElements(els, parsePredicate({ name: 'send', nameExact: true }, 'find')).map(
        (m) => m.ref,
      ),
    ).toEqual(['@e1']);
  });

  it('excludes elements without a name when a name predicate is given', () => {
    expect(
      matchElements(els, parsePredicate({ role: 'button', name: 'Send' }, 'find')).map(
        (m) => m.ref,
      ),
    ).toEqual(['@e1', '@e2']);
  });

  it('matches value as a substring on String(value)', () => {
    const withVals = [el('@e1', 'textbox', 'A', 'hello world'), el('@e2', 'textbox', 'B', 42)];
    expect(matchElements(withVals, parsePredicate({ value: 'world' }, 'find')).map((m) => m.ref)).toEqual(
      ['@e1'],
    );
    expect(matchElements(withVals, parsePredicate({ value: '42' }, 'find')).map((m) => m.ref)).toEqual([
      '@e2',
    ]);
  });

  it('ANDs all provided fields', () => {
    expect(
      matchElements(els, parsePredicate({ role: 'button', name: 'message' }, 'find')).map(
        (m) => m.ref,
      ),
    ).toEqual(['@e2']);
  });
});
