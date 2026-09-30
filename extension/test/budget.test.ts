import { describe, expect, it } from 'vitest';

import {
  budgetLeft,
  CALL_BUDGET_MS,
  loadTimeoutMs,
  MIN_LOAD_TIMEOUT_MS,
  OBSERVE_RESERVE_MS,
  raceDeadline,
  stepDeadlineMs,
} from '../src/tools/budget.js';

describe('budgetLeft', () => {
  it('is unbounded for a call with no recorded start', () => {
    expect(budgetLeft(undefined, 123)).toBe(Infinity);
  });

  it('counts down from the call start, reserve included, never below zero', () => {
    expect(budgetLeft(1000, 1000)).toBe(CALL_BUDGET_MS);
    expect(budgetLeft(0, 10_000, OBSERVE_RESERVE_MS)).toBe(
      CALL_BUDGET_MS - OBSERVE_RESERVE_MS - 10_000,
    );
    expect(budgetLeft(0, CALL_BUDGET_MS + 1)).toBe(0);
  });

  it('leaves an observation at least 10 s before the daemon gives up at 60 s', () => {
    expect(60_000 - CALL_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('loadTimeoutMs', () => {
  it('is the usual 30 s for a fresh call', () => {
    expect(loadTimeoutMs(0, 0)).toBe(30_000);
    expect(loadTimeoutMs(undefined, 0)).toBe(30_000);
  });

  it('shrinks to what a queued call has left', () => {
    // 35 s spent queued behind another call on the same tab.
    expect(loadTimeoutMs(0, 35_000)).toBe(CALL_BUDGET_MS - 35_000);
  });

  it('keeps a floor, so an overdrawn call fails fast with a retryable timeout', () => {
    expect(loadTimeoutMs(0, 70_000)).toBe(MIN_LOAD_TIMEOUT_MS);
  });
});

describe('stepDeadlineMs / raceDeadline (a page step that may never settle)', () => {
  it('bounds a step by what the call has left, never past the whole budget', () => {
    expect(stepDeadlineMs(undefined, 0)).toBe(CALL_BUDGET_MS);
    expect(stepDeadlineMs(0, 40_000)).toBe(CALL_BUDGET_MS - 40_000);
    expect(stepDeadlineMs(0, 90_000)).toBe(0);
  });

  it('passes a settled result through', async () => {
    await expect(raceDeadline(Promise.resolve(7), 1000, () => new Error('late'))).resolves.toBe(7);
  });

  it('rejects with the given error when the step never settles', async () => {
    const never = new Promise<number>(() => {});
    await expect(raceDeadline(never, 20, () => new Error('late'))).rejects.toThrow('late');
  });
});
