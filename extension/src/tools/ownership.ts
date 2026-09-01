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

/** Field the daemon injects carrying the calling session's cosmetic label (its
 * working-directory name, sanitised broker-side). Must match the daemon's
 * ownership.CLIENT_LABEL_ARG byte-for-byte. It is peer-declared and therefore
 * NEVER an identity: it only tags audit rows and groups the session's tabs into
 * their own window. Ownership keys on the server-minted clientId, which never
 * leaves the daemon. */
export const CLIENT_LABEL_ARG = 'clientLabel';

let brokerMode = false;

/** Record the daemon's broker-vs-standalone signal (from the hello_ack). */
export function setBrokerMode(on: boolean): void {
  brokerMode = on;
}

export function isBrokerMode(): boolean {
  return brokerMode;
}

/** What we know about one agent-created tab.
 *
 * `epoch` is the only load-bearing field — it is what invariant #13 confirms.
 * The rest is BOOKKEEPING for the tab reaper (`planEviction`), which decides
 * which of our own tabs may be closed to keep the browser from filling up. It
 * is deliberately advisory: losing all of it (a service worker eviction with a
 * failed persist) costs a worse eviction order, never a wrong gate. */
export type TabRecord = {
  /** Create-time epoch — the ownership token invariant #13 rests on. */
  epoch: string;
  /** Cosmetic session label of the client that created the tab, for grouping.
   * Peer-declared, never an identity (see `CLIENT_LABEL_ARG`) — the reaper only
   * uses it to avoid evicting a DIFFERENT live session's tabs. */
  session?: string;
  /** When a tool last drove this tab (ms). The reaper's LRU key. */
  lastUsed: number;
  /** The HUMAN engaged with this tab — activated it in a focused window, or
   * dragged it into one of their own. Never auto-closed after that: the whole
   * reason `close_tab` is gated is that destroying something a person is
   * looking at is unrecoverable. One-way; nothing ever clears it. */
  human: boolean;
  /** The session that created this tab has disconnected (`_release_tabs`'
   * hand-back path). No client can name the tab any more, so it will never be
   * used again — which makes it the first thing the reaper should take. */
  orphaned: boolean;
};

// tabId -> record. Every key is an AGENT-created tab; a tab the human
// opened never appears here — which is exactly what owner-scopes `list_tabs`.
const epochByTab = new Map<number, TabRecord>();

/** Mint and store a fresh epoch for a just-created tab. The epoch is an opaque
 * unguessable token; what matters is that re-creating (or recycling) an id
 * yields a different epoch, so a stale daemon reference can be detected.
 *
 * `session` is the creating client's cosmetic label, remembered so the reaper
 * can tell "this session's own older tab" from "another live session's tab". */
export function mintEpoch(tabId: number, session?: string): string {
  const epoch = crypto.randomUUID();
  epochByTab.set(tabId, {
    epoch,
    ...(session ? { session } : {}),
    lastUsed: Date.now(),
    human: false,
    orphaned: false,
  });
  return epoch;
}

export function getEpoch(tabId: number): string | undefined {
  return epochByTab.get(tabId)?.epoch;
}

/** Note that a tool just drove this tab (the reaper's LRU key). Silently
 * ignores a tab we don't own — every tool call goes through here, and in
 * standalone the map is always empty. */
export function touchTab(tabId: number, now: number = Date.now()): void {
  const rec = epochByTab.get(tabId);
  if (rec) rec.lastUsed = now;
}

/** Mark a tab as one the HUMAN engaged with — it is never auto-closed again.
 * Returns whether this changed anything, so the caller can skip a redundant
 * persist (activation events are frequent; writes to storage.session are not
 * free). */
export function markHumanTab(tabId: number): boolean {
  const rec = epochByTab.get(tabId);
  if (!rec || rec.human) return false;
  rec.human = true;
  return true;
}

/** Mark a tab as orphaned — its session is gone and handed it back. Returns
 * whether this changed anything (same persist-skipping reason as above). */
export function markOrphanedTab(tabId: number): boolean {
  const rec = epochByTab.get(tabId);
  if (!rec || rec.orphaned) return false;
  rec.orphaned = true;
  return true;
}

/** Has this tab's session ended (`_release_tabs` handed it back)? */
export function tabIsOrphaned(tabId: number): boolean {
  return epochByTab.get(tabId)?.orphaned === true;
}

/** One record plus the id it is keyed by — the reaper's input row. */
export type AgentTabInfo = TabRecord & { tabId: number };

/** Everything the reaper needs, as a plain array — so `planEviction` can stay a
 * pure function over data instead of reaching into module state. */
export function agentTabInfo(): AgentTabInfo[] {
  return [...epochByTab.entries()].map(([tabId, rec]) => ({ tabId, ...rec }));
}

/** Tabs the PAGE opened, adopted for the session that owns the opener, waiting
 * to be reported back in that call's result. Keyed by opener tab id.
 *
 * A `target="_blank"` link, a `window.open`, an OAuth popup — the browser makes
 * the tab, not us, so it had no epoch, and everything downstream then treated it
 * as a stranger: `list_tabs` filtered it out (owner-scoped both sides), the
 * daemon answered `tab_not_owned` for it, the popup's "Agent tabs" sweep never
 * listed it and the reaper never counted it. The agent was stuck looking at a
 * page it could not name, and the human got a tab nothing tracked.
 *
 * A tab spawned BY a tab you own is yours: the call that spawned it had already
 * passed `ensure_owns` on the opener. So it is adopted here and reported in the
 * result, which is the same route `navigate`'s own create takes to the daemon's
 * registry — nothing new is trusted. */
const adoptedByOpener = new Map<number, Array<{ tabId: number; epoch: string }>>();

/** How many un-reported adoptions we keep per opener. A page that opens tabs in
 * a loop must not grow this without bound; the tabs themselves are still real,
 * and the popup's sweep still sees them (they hold an epoch). */
const MAX_PENDING_ADOPTIONS = 20;

/** Adopt a tab the page opened, if its opener is one of ours. Returns whether
 * it was adopted, so the caller knows to persist. */
export function adoptOpenedTab(tabId: number, openerTabId: number | undefined): boolean {
  if (typeof openerTabId !== 'number') return false;
  const opener = epochByTab.get(openerTabId);
  if (!opener) return false; // opener is the human's tab, or standalone
  if (epochByTab.has(tabId)) return false; // already ours (we created it)
  const epoch = crypto.randomUUID();
  epochByTab.set(tabId, {
    epoch,
    ...(opener.session ? { session: opener.session } : {}),
    lastUsed: Date.now(),
    human: false,
    orphaned: false,
  });
  const pending = adoptedByOpener.get(openerTabId) ?? [];
  if (pending.length < MAX_PENDING_ADOPTIONS) pending.push({ tabId, epoch });
  adoptedByOpener.set(openerTabId, pending);
  return true;
}

/** Take (and forget) the tabs adopted for this opener since the last read. The
 * caller reports them in its tool result so the DAEMON can record ownership —
 * until it does, the tab is ours extension-side but nameless to any client. */
export function takeAdoptedTabs(openerTabId: number): Array<{ tabId: number; epoch: string }> {
  const pending = adoptedByOpener.get(openerTabId);
  if (!pending?.length) return [];
  adoptedByOpener.delete(openerTabId);
  return pending;
}

/** Confirm a daemon-supplied expected epoch against what we recorded for the
 * tab. No-op when `expected` is absent (standalone, or a create call carries
 * none). A mismatch or unknown tab means the id was recycled or the tab is gone
 * since the daemon last saw it → `tab_gone` (the caller owned it, so naming the
 * condition specifically is safe — it is not an oracle for someone else's tab). */
export function confirmEpoch(tabId: number, expected: unknown): void {
  if (typeof expected !== 'string') return;
  if (epochByTab.get(tabId)?.epoch !== expected) {
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
  // Also drop anything queued FOR this tab as an opener: if the opener closed
  // before its result was reported, nobody is going to read that queue.
  adoptedByOpener.delete(tabId);
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

/** Strip the broker-internal fields (epoch, session label) from a tool_call's
 * args, so neither the tool body nor the audit's `args` sees them as ordinary
 * arguments. Returns a copy; the original is untouched. No-op (returns the same
 * object) when neither field is present. */
export function stripBrokerArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!(EXPECTED_EPOCH_ARG in args) && !(CLIENT_LABEL_ARG in args)) return args;
  const rest = { ...args };
  delete rest[EXPECTED_EPOCH_ARG];
  delete rest[CLIENT_LABEL_ARG];
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
export function serializeEpochs(): Record<string, TabRecord> {
  const out: Record<string, TabRecord> = {};
  for (const [tabId, rec] of epochByTab) out[String(tabId)] = { ...rec };
  return out;
}

/** Replace the in-memory map from a chrome.storage.session snapshot (SW wake).
 * Tolerates malformed snapshots — a corrupt entry is skipped, never thrown, so
 * a bad snapshot can never wedge startup.
 *
 * A BARE STRING is still accepted as an epoch-only record: that is the shape
 * this map had before it carried reaper bookkeeping, and a snapshot written by
 * the previous build survives the extension reload that installs this one (the
 * storage outlives the service worker, not just the worker's memory). Reading
 * it as garbage would silently un-own every live agent tab — every subsequent
 * call on them would answer `tab_gone`. The missing bookkeeping defaults to
 * "never driven, never looked at", which only makes such a tab an earlier
 * eviction candidate — advisory, exactly as the record documents. */
export function hydrateEpochs(stored: unknown): void {
  epochByTab.clear();
  if (stored === null || typeof stored !== 'object') return;
  for (const [key, val] of Object.entries(stored as Record<string, unknown>)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId)) continue;
    if (typeof val === 'string') {
      epochByTab.set(tabId, { epoch: val, lastUsed: 0, human: false, orphaned: false });
      continue;
    }
    if (!val || typeof val !== 'object') continue;
    const rec = val as Partial<TabRecord>;
    if (typeof rec.epoch !== 'string') continue;
    epochByTab.set(tabId, {
      epoch: rec.epoch,
      ...(typeof rec.session === 'string' && rec.session ? { session: rec.session } : {}),
      lastUsed:
        typeof rec.lastUsed === 'number' && Number.isFinite(rec.lastUsed) ? rec.lastUsed : 0,
      human: rec.human === true,
      orphaned: rec.orphaned === true,
    });
  }
}

/** Which of our own tabs to close before opening one more (the tab reaper).
 *
 * The problem it solves is mundane and was the loudest thing wrong with running
 * this for real: in broker mode a `navigate` with no tabId CREATES a tab, so an
 * agent working through twenty pages leaves twenty tabs, every finished session
 * hands its own back rather than closing them (that default is deliberate — see
 * `release.ts`), and nothing ever bounded the total. After a day of use the
 * human has a browser full of tabs no client can even name any more.
 *
 * The policy is written to never be the thing that loses work:
 *  - a tab the HUMAN engaged with is never a candidate, at any pressure;
 *  - a LIVE other session's tabs are never candidates — evicting those would
 *    break an agent that is mid-task, and this runs on someone else's create;
 *  - orphans go first (their session is gone, so nobody can ever name them
 *    again), then the creating session's OWN least-recently-used tabs, which is
 *    the one case where the loser is the caller itself;
 *  - it only ever frees enough room to land at `cap`, never more;
 *  - `cap <= 0` disables it entirely.
 *
 * A tab we do close leaves the daemon's registry stale, and that is already a
 * handled case: the next call naming it fails `confirmEpoch` with `tab_gone`,
 * a documented, recoverable error whose recovery hint is "open a fresh tab".
 *
 * Pure, so the policy is unit-tested rather than inferred from chrome calls. */
export function planEviction(tabs: AgentTabInfo[], cap: number, session?: string): number[] {
  if (!Number.isFinite(cap) || cap <= 0) return [];
  // +1: we are about to add one, and the point is to land AT the cap.
  const excess = tabs.length + 1 - cap;
  if (excess <= 0) return [];
  const byAge = (a: AgentTabInfo, b: AgentTabInfo) => a.lastUsed - b.lastUsed || a.tabId - b.tabId;
  const spare = tabs.filter((t) => !t.human);
  const orphans = spare.filter((t) => t.orphaned).sort(byAge);
  const own = spare.filter((t) => !t.orphaned && (t.session ?? '') === (session ?? '')).sort(byAge);
  // At most ONE tab that is still in play, per create. The cap is global but a
  // session only controls its own tabs, so with several agents running the
  // excess can be far larger than anything this caller caused — and taking
  // `excess` live tabs would make a session that opens one more page destroy
  // its entire working set to satisfy a number two other sessions filled up.
  // One per create is self-correcting instead: each create adds one tab and
  // retires one, so a single session settles exactly at the cap, and a browser
  // that is over it stops growing rather than collapsing. Orphans have no such
  // caveat — their session has exited, so nobody is mid-task on them.
  return [...orphans, ...own.slice(0, 1)].slice(0, excess).map((t) => t.tabId);
}

/** Reset all ownership state (test hook; also the clean-slate on unpair). */
export function clearAllEpochs(): void {
  epochByTab.clear();
  adoptedByOpener.clear();
  brokerMode = false;
}
