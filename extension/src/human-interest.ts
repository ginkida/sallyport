/** "The human looked at this one" — the tab reaper's stop sign, and what keeps
 * a tab's beforeunload prompt (quiet-leave.ts:mayCloseQuietly).
 *
 * `maxAgentTabs` lets the reaper close agent tabs to keep the browser from
 * filling up (ownership.ts:planEviction), and an agent tab leaves without its
 * "Leave site?" prompt. Neither may happen to a tab a person is actually using,
 * and the browser already tells us which those are: a tab the human ACTIVATED
 * in a window they have in front of them, or one they dragged into a window of
 * their own. The mark is one-way — nothing ever clears it — because "I looked
 * at this once" is a permanent fact about that tab, and being wrong in this
 * direction only costs one tab.
 *
 * The focused-window condition is what makes this usable rather than noise:
 * `screenshot` makes an agent tab active INSIDE its own unfocused window (that
 * is why it costs no focus), which fires exactly the same event. Without the
 * check, the agent would immortalise its own tabs by screenshotting them.
 *
 * Split out of background.ts (pure wiring) so the timing is testable. */

import { agentTabIds, getEpoch, markHumanTab } from './tools/ownership.js';
import { persistEpochs } from './tools/ownership-store.js';
import { graceRemainingMs, onAgentWindowCreated } from './tools/agent-window.js';

/** How long after we create an agent window a focus event on it is discounted
 * (see agent-window.ts:wasJustCreated). */
export const HUMAN_FOCUS_GRACE_MS = 2000;

/** After the grace, how often and how many times the re-check looks again for
 * a window whose first tab is not ours YET: navigate mints the epoch only after
 * its create and attach, and a slow attach can outlast the grace. */
export const MINT_WAIT_STEP_MS = 500;
export const MINT_WAIT_TRIES = 10;

function noteHumanInterest(tabId: number | undefined): void {
  if (typeof tabId !== 'number') return;
  if (markHumanTab(tabId)) void persistEpochs();
}

async function windowIsFocused(windowId: number): Promise<boolean> {
  try {
    return (await chrome.windows.get(windowId))?.focused === true;
  } catch {
    return false; // window gone — nothing to conclude
  }
}

async function activeTabOf(windowId: number): Promise<number | undefined> {
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    return active?.id;
  } catch {
    return undefined; // window/tab gone between the event and the query
  }
}

export function onTabActivated({ tabId, windowId }: { tabId: number; windowId: number }): void {
  // Cheap synchronous bail FIRST. This fires on every tab switch the human
  // makes, all day, and in standalone the owned set is always empty — asking
  // the browser about the window before asking our own map would put a chrome
  // round-trip on a hot path that answers "not ours" essentially every time.
  if (getEpoch(tabId) === undefined) return;
  void (async () => {
    if (await windowIsFocused(windowId)) noteHumanInterest(tabId);
  })();
}

/** Dragged out of the agent window into one of the human's own — an
 * unambiguous "this is mine now", and the reason ownership never keys on
 * windowId. */
export function onTabAttached(tabId: number): void {
  noteHumanInterest(tabId);
}

export function onWindowFocusChanged(windowId: number): void {
  // WINDOW_ID_NONE: focus left Chrome entirely.
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  // Focus on a window we created a moment ago is discounted HERE — its own
  // creation armed the look that counts (`watchCreatedWindow`). Asked before
  // anything else: the create-time event arrives before the window's first
  // tab is ours, so an "anything of ours at all?" bail placed first used to
  // skip the re-check for a session's first window.
  if (graceRemainingMs(windowId, HUMAN_FOCUS_GRACE_MS) > 0) return;
  if (agentTabIds().size === 0) return; // nothing of ours to mark (standalone)
  void (async () => {
    const tabId = await activeTabOf(windowId);
    if (tabId !== undefined && getEpoch(tabId) !== undefined) noteHumanInterest(tabId);
  })();
}

/** Called for every agent window WE create, the moment `windows.create`
 * answers. Focus on it inside the grace is discounted, but NOT forgotten: if
 * the window still holds focus once the grace is over, the human is in it
 * (they clicked into it inside the grace, or it took focus despite
 * `focused:false` and stayed in front of them), and its active tab — already
 * active, so no onActivated will ever come — is theirs. Otherwise that tab
 * would stay quietly closable while a person types into it.
 *
 * Armed from the creation, not from the window's focus event: that event can
 * arrive before `createdAt` is recorded or before the tab has an epoch. And
 * if the epoch still isn't there at grace end, it looks again for a while. */
export function watchCreatedWindow(windowId: number): void {
  let tries = 0;
  const check = async (): Promise<void> => {
    if (!(await windowIsFocused(windowId))) return;
    const tabId = await activeTabOf(windowId);
    if (tabId === undefined) return;
    if (getEpoch(tabId) !== undefined) {
      noteHumanInterest(tabId);
      return;
    }
    if (++tries < MINT_WAIT_TRIES) setTimeout(() => void check(), MINT_WAIT_STEP_MS);
  };
  setTimeout(() => void check(), graceRemainingMs(windowId, HUMAN_FOCUS_GRACE_MS) + 50);
}

/** Register the listeners (background.ts, at worker load). */
export function installHumanInterestListeners(): void {
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onAttached.addListener(onTabAttached);
  chrome.windows?.onFocusChanged.addListener(onWindowFocusChanged);
  onAgentWindowCreated(watchCreatedWindow);
}
