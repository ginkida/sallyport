/** Per-client tab ownership — the extension's half (security invariant #13).
 *
 * The DAEMON is the authoritative ownership gate: it alone knows the per-client
 * `clientId`, and it rejects a call for a tab the client doesn't own before the
 * extension ever sees it. This module is the identity-blind, defence-in-depth
 * half that lives next to the browser:
 *
 *  - `epochByTab` records a create-time `epoch` for every tab the agent created
 *    through this extension. Chrome recycles tab ids, so if the daemon hands us
 *    an `expectedEpoch` for a tabId whose recorded epoch no longer matches, the
 *    id was recycled (or the tab is gone) and we refuse with `tab_gone` instead
 *    of acting on the wrong page (`confirmEpoch`).
 *  - `brokerMode` (signalled by the daemon in the hello_ack) gates the
 *    broker-only behaviours the daemon gate can't reach from outside the
 *    browser: owner-scoping `list_tabs` to agent-created tabs (so the human's
 *    tabs never cross the wire) and the focus-theft mitigation.
 *
 * Deliberately pure / chrome-free (so it is unit-gated in vitest). The callers
 * own the chrome wiring: persistence to `chrome.storage.session` (survives MV3
 * service-worker eviction), the reconcile against `chrome.tabs.query`, and the
 * `chrome.tabs.onRemoved` drop all drive the primitives here.
 */

import { BridgeError } from './errors.js';

/** Field the daemon injects into a tool_call's args carrying the create-time
 * epoch it recorded for the owned tab, for the extension to confirm. Must match
 * the daemon's ownership.EPOCH_ARG byte-for-byte (it is part of the contract). */
export const EXPECTED_EPOCH_ARG = 'expectedEpoch';

let brokerMode = false;

/** Record the daemon's broker-vs-standalone signal (from the hello_ack). */
export function setBrokerMode(on: boolean): void {
  brokerMode = on;
}

export function isBrokerMode(): boolean {
  return brokerMode;
}

// tabId -> create-time epoch. Every key is an AGENT-created tab; a tab the human
// opened never appears here — which is exactly what owner-scopes `list_tabs`.
const epochByTab = new Map<number, string>();

/** Mint and store a fresh epoch for a just-created tab. The epoch is an opaque
 * unguessable token; what matters is that re-creating (or recycling) an id
 * yields a different epoch, so a stale daemon reference can be detected. */
export function mintEpoch(tabId: number): string {
  const epoch = crypto.randomUUID();
  epochByTab.set(tabId, epoch);
  return epoch;
}

export function getEpoch(tabId: number): string | undefined {
  return epochByTab.get(tabId);
}

/** Confirm a daemon-supplied expected epoch against what we recorded for the
 * tab. No-op when `expected` is absent (standalone, or a create call carries
 * none). A mismatch or unknown tab means the id was recycled or the tab is gone
 * since the daemon last saw it → `tab_gone` (the caller owned it, so naming the
 * condition specifically is safe — it is not an oracle for someone else's tab). */
export function confirmEpoch(tabId: number, expected: unknown): void {
  if (typeof expected !== 'string') return;
  if (epochByTab.get(tabId) !== expected) {
    throw new BridgeError(
      'tab_gone',
      'tab has closed or its id was recycled since it was created — open a fresh tab',
    );
  }
}

/** Forget a tab's epoch (it closed). Returns whether an entry was actually
 * removed, so the caller can skip a redundant persist — in standalone the map is
 * always empty, so every tab-close would otherwise write an empty snapshot. */
export function dropEpoch(tabId: number): boolean {
  return epochByTab.delete(tabId);
}

/** Refuse a focus-stealing screenshot in broker mode: `bringToFront` foregrounds
 * the agent's tab, yanking away whatever the human was looking at. In standalone
 * the call is the user's own, so it is allowed. (Focus-theft mitigation, #13.) */
export function assertBringToFrontAllowed(bringToFront: boolean): void {
  if (bringToFront && brokerMode) {
    throw new BridgeError(
      'bringtofront_forbidden',
      'screenshot: bringToFront is disabled in broker mode — it would foreground the agent ' +
        'tab and steal your focus; the tab must already be the active tab in its window, or ' +
        'use snapshot/read_text which need no visible tab',
    );
  }
}

/** Strip the broker-internal epoch field from a tool_call's args, so neither the
 * tool body nor the audit log ever sees it. Returns a copy; the original is
 * untouched. No-op (returns the same object) when the field is absent. */
export function stripEpochArg(args: Record<string, unknown>): Record<string, unknown> {
  if (!(EXPECTED_EPOCH_ARG in args)) return args;
  const rest = { ...args };
  delete rest[EXPECTED_EPOCH_ARG];
  return rest;
}

/** The set of agent-created tab ids — `list_tabs` is scoped to these in broker
 * mode so the human's tabs never leave the browser. */
export function agentTabIds(): Set<number> {
  return new Set(epochByTab.keys());
}

/** Keep only the tabs whose id is in `owned` — the extension-side half of
 * owner-scoped `list_tabs` (the daemon scopes again per-client). Used only in
 * broker mode; standalone returns the full list. */
export function filterTabsToOwned<T extends { tabId?: number }>(
  tabs: T[],
  owned: Set<number>,
): T[] {
  return tabs.filter((t) => typeof t.tabId === 'number' && owned.has(t.tabId));
}

/** Drop epochs for tabs that no longer exist — reconcile against the live tab
 * set (chrome.tabs.query) on service-worker wake, before honouring any owned-tab
 * call. Returns the removed ids. */
export function reconcileEpochs(liveTabIds: Set<number>): number[] {
  const removed: number[] = [];
  for (const tabId of epochByTab.keys()) {
    if (!liveTabIds.has(tabId)) removed.push(tabId);
  }
  for (const tabId of removed) epochByTab.delete(tabId);
  return removed;
}

/** Serialise for chrome.storage.session (object keys must be strings). */
export function serializeEpochs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tabId, epoch] of epochByTab) out[String(tabId)] = epoch;
  return out;
}

/** Replace the in-memory map from a chrome.storage.session snapshot (SW wake).
 * Tolerates malformed snapshots — a corrupt entry is skipped, never thrown, so
 * a bad snapshot can never wedge startup. */
export function hydrateEpochs(stored: unknown): void {
  epochByTab.clear();
  if (stored === null || typeof stored !== 'object') return;
  for (const [key, val] of Object.entries(stored as Record<string, unknown>)) {
    const tabId = Number(key);
    if (Number.isInteger(tabId) && typeof val === 'string') {
      epochByTab.set(tabId, val);
    }
  }
}

/** Reset all ownership state (test hook; also the clean-slate on unpair). */
export function clearAllEpochs(): void {
  epochByTab.clear();
  brokerMode = false;
}
