// Pure helper: connection state → toolbar badge.
//
// We surface the connection state on the toolbar icon so the user knows at a
// glance whether the bridge needs attention — without opening the popup.
// "Healthy" is silent (no badge) by design: a permanent badge would just
// teach the user to ignore it.

import type { StatusSnapshot } from './bridge-connection.js';

export type Badge = {
  /** Text shown on the toolbar icon. Empty string clears the badge. */
  text: string;
  /** Background color for the badge (CSS hex or #rgba). */
  color: string;
};

const HEALTHY: Badge = { text: '', color: '#00000000' };

const COLORS = {
  red: '#e85a5a',
  yellow: '#e8b34e',
  gray: '#5a5a60',
} as const;

/**
 * Map connection state + paused flag to badge text/color.
 *
 * - paused → grey "II" (intentional, user-driven, not an error)
 * - connected → no badge (healthy state should not be noisy)
 * - connecting → yellow "…" (transient, will settle)
 * - disconnected / no_secret → red "!" (action required)
 */
export function badgeFromStatus(status: StatusSnapshot, paused: boolean): Badge {
  if (paused) return { text: 'II', color: COLORS.gray };
  switch (status.state) {
    case 'connected':
      return HEALTHY;
    case 'connecting':
      return { text: '…', color: COLORS.yellow };
    case 'disconnected':
    case 'no_secret':
      return { text: '!', color: COLORS.red };
  }
}
