import { describe, expect, it } from 'vitest';
import { nextReconnectKick } from '../src/reconnect-kick.js';

describe('nextReconnectKick', () => {
  it('kicks once on the first disconnected observation', () => {
    expect(nextReconnectKick('disconnected', false, false)).toEqual({ kick: true, kicked: true });
  });

  it('does not kick again while still disconnected (latched)', () => {
    expect(nextReconnectKick('disconnected', false, true)).toEqual({ kick: false, kicked: true });
  });

  it('never kicks while paused, and leaves the latch untouched', () => {
    expect(nextReconnectKick('disconnected', true, false)).toEqual({ kick: false, kicked: false });
    expect(nextReconnectKick('disconnected', true, true)).toEqual({ kick: false, kicked: true });
  });

  it('clears the latch once connected so a later drop re-kicks', () => {
    expect(nextReconnectKick('connected', false, true)).toEqual({ kick: false, kicked: false });
    // After the reset, a fresh disconnect kicks again.
    expect(nextReconnectKick('disconnected', false, false)).toEqual({ kick: true, kicked: true });
  });

  it('does not kick while connecting; preserves the latch', () => {
    expect(nextReconnectKick('connecting', false, false)).toEqual({ kick: false, kicked: false });
    expect(nextReconnectKick('connecting', false, true)).toEqual({ kick: false, kicked: true });
  });

  it('does not kick when unpaired (no_secret)', () => {
    expect(nextReconnectKick('no_secret', false, false)).toEqual({ kick: false, kicked: false });
  });
});
