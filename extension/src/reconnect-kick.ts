// Pure decision for the popup's "kick a reconnect when I open" behaviour.
//
// Opening the popup should not sit through the remaining reconnect backoff if
// the daemon is reachable again — but it must not hammer a daemon that is
// simply down. So we kick exactly once per disconnected episode: fire when we
// first see `disconnected` (and are paired + not paused), then stay quiet
// until a live connection resets the latch. Extracted from popup.ts so the
// latch logic is unit-testable without a chrome popup harness.

export type KickState = 'disconnected' | 'connecting' | 'connected' | 'no_secret';

export type KickDecision = {
  /** Send a RECONNECT to the service worker now. */
  kick: boolean;
  /** The next value of the caller's "already kicked this episode" latch. */
  kicked: boolean;
};

export function nextReconnectKick(
  state: KickState,
  paused: boolean,
  kicked: boolean,
): KickDecision {
  // A live connection clears the latch so a later drop re-kicks once.
  if (state === 'connected') return { kick: false, kicked: false };
  // Kick once when we land in disconnected while paired and not paused.
  if (state === 'disconnected' && !paused && !kicked) return { kick: true, kicked: true };
  // connecting / no_secret / already-kicked / paused → do nothing, latch as-is.
  return { kick: false, kicked };
}
