import { describe, expect, it } from 'vitest';
import { releaseAction } from '../src/tools/release.js';

describe('releaseAction — what happens to a disconnected session tabs', () => {
  it('hands tabs back by default rather than closing them', () => {
    // Closing an agent's half-finished work is exactly the loss invariant #12
    // gates close_tab against, and for an interactive session those tabs are
    // usually the result the human wanted to see.
    expect(releaseAction(false)).toBe('hand-back');
  });

  it('closes them when the human opted in (ephemeral agents)', () => {
    // A dispatched one-shot run is a new MCP session every time, so its tabs
    // are orphaned on exit and no later session can reach them — they are
    // owner-scoped and the epoch is dropped on release.
    expect(releaseAction(true)).toBe('close');
  });
});
