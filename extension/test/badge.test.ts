import { describe, expect, it } from 'vitest';
import { badgeFromStatus } from '../src/badge.js';
import type { StatusSnapshot } from '../src/bridge-connection.js';

const snap = (state: StatusSnapshot['state']): StatusSnapshot => ({
  state,
  serverUrl: 'ws://127.0.0.1:10086/ws',
  lastError: null,
});

describe('badgeFromStatus', () => {
  it('shows nothing when healthy', () => {
    expect(badgeFromStatus(snap('connected'), false)).toEqual({ text: '', color: '#00000000' });
  });

  it('shows yellow "…" while connecting', () => {
    const b = badgeFromStatus(snap('connecting'), false);
    expect(b.text).toBe('…');
    expect(b.color).toBe('#e8b34e');
  });

  it('shows red "!" when disconnected', () => {
    const b = badgeFromStatus(snap('disconnected'), false);
    expect(b.text).toBe('!');
    expect(b.color).toBe('#e85a5a');
  });

  it('shows red "!" when no secret', () => {
    expect(badgeFromStatus(snap('no_secret'), false).text).toBe('!');
  });

  it('paused beats everything else', () => {
    // Even if the underlying state says "connected", a paused user has
    // explicitly disabled the bridge — show the grey paused indicator.
    const b = badgeFromStatus(snap('connected'), true);
    expect(b.text).toBe('II');
    expect(b.color).toBe('#5a5a60');
  });
});
