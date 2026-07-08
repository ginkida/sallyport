import { describe, expect, it } from 'vitest';

import { BridgeError } from '../src/tools/errors.js';
import {
  parseHistoryDirection,
  parseHistorySteps,
  planHistoryHop,
  type HistoryEntry,
} from '../src/tools/history.js';

const entries: HistoryEntry[] = [
  { id: 10, url: 'https://a.example/start' },
  { id: 11, url: 'https://a.example/middle' },
  { id: 12, url: 'https://b.example/other' },
  { id: 13, url: 'https://a.example/current' },
];
const allowAExample = (url: string): boolean => new URL(url).hostname === 'a.example';

describe('parseHistoryDirection', () => {
  it('accepts back/forward', () => {
    expect(parseHistoryDirection('back')).toBe('back');
    expect(parseHistoryDirection('forward')).toBe('forward');
  });

  it('rejects anything else', () => {
    expect(() => parseHistoryDirection(undefined)).toThrowError(BridgeError);
    expect(() => parseHistoryDirection('backward')).toThrowError(/direction/);
    expect(() => parseHistoryDirection(1)).toThrowError(BridgeError);
  });
});

describe('parseHistorySteps', () => {
  it('defaults to 1', () => {
    expect(parseHistorySteps(undefined)).toBe(1);
    expect(parseHistorySteps(null)).toBe(1);
  });

  it('accepts positive integers', () => {
    expect(parseHistorySteps(3)).toBe(3);
  });

  it('rejects zero, negatives, fractions and non-numbers', () => {
    expect(() => parseHistorySteps(0)).toThrowError(BridgeError);
    expect(() => parseHistorySteps(-2)).toThrowError(BridgeError);
    expect(() => parseHistorySteps(1.5)).toThrowError(BridgeError);
    expect(() => parseHistorySteps('two')).toThrowError(BridgeError);
    expect(() => parseHistorySteps(Number.MAX_SAFE_INTEGER + 1)).toThrowError(BridgeError);
  });
});

describe('planHistoryHop', () => {
  it('goes back N steps to the right entry', () => {
    expect(planHistoryHop(entries, 3, 'back', 1, () => true).id).toBe(12);
    expect(planHistoryHop(entries, 3, 'back', 3, () => true).id).toBe(10);
  });

  it('goes forward from an earlier position', () => {
    expect(planHistoryHop(entries, 0, 'forward', 2, () => true).id).toBe(12);
  });

  it('no_history when the hop overshoots, message says how far it reaches', () => {
    expect(() => planHistoryHop(entries, 3, 'back', 4, () => true)).toThrowError(/only 3 entries/);
    expect(() => planHistoryHop(entries, 2, 'forward', 2, () => true)).toThrowError(
      /only 1 entry /,
    );
    try {
      planHistoryHop(entries, 3, 'back', 4, () => true);
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe('no_history');
    }
  });

  it('no_history at the very edge (nothing behind / ahead)', () => {
    expect(() => planHistoryHop(entries, 0, 'back', 1, () => true)).toThrowError(/nothing behind/);
    expect(() => planHistoryHop(entries, 3, 'forward', 1, () => true)).toThrowError(
      /nothing ahead/,
    );
  });

  it('gates the LANDING entry against the allowlist', () => {
    // back 1 lands on b.example — refused; back 2 lands on a.example — fine.
    try {
      planHistoryHop(entries, 3, 'back', 1, allowAExample);
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe('domain_not_allowed');
      expect((e as BridgeError).message).toContain('b.example');
    }
    expect(planHistoryHop(entries, 3, 'back', 2, allowAExample).id).toBe(11);
  });

  it('intermediate non-allowlisted entries do not block a jump over them', () => {
    // 0 → forward 3 hops OVER b.example (index 2) and lands on a.example.
    expect(planHistoryHop(entries, 0, 'forward', 3, allowAExample).id).toBe(13);
  });
});
