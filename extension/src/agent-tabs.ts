import { agentTabInfo, agentTabRecord } from './tools/ownership.js';

export type AgentTabRow = {
  tabId: number;
  title: string;
  url: string;
  session?: string;
  orphaned: boolean;
  human: boolean;
};

/** `skipped` counts candidates whose state changed under the sweep — including
 * tabs that were already gone by the time we reached them. `failed` is a
 * removal Chrome actually refused. */
export type CloseAgentTabsResult = { closed: number; failed: number; skipped: number };

/** Chrome's rejection for a tab that no longer exists ("No tab with id: 42.").
 * Not a failure: the human (or the reaper) got there first. */
export function isMissingTabError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no tab with id/i.test(message);
}

/** Labels follow the creating session even if the tab moves between windows. */
export async function listAgentTabs(): Promise<AgentTabRow[]> {
  const tabs = await chrome.tabs.query({});
  const owned = new Map(agentTabInfo().map((info) => [info.tabId, info]));
  return tabs.flatMap((tab) => {
    const info = tab.id === undefined ? undefined : owned.get(tab.id);
    if (!info) return [];
    return [
      {
        tabId: info.tabId,
        title: tab.title ?? '',
        url: tab.url ?? '',
        session: info.session,
        orphaned: info.orphaned,
        human: info.human,
      },
    ];
  });
}

/** Revalidate each candidate immediately before removal. A batch may yield
 * while another tab closes, changes ownership, or becomes important to a human. */
export async function closeAgentTabs(scope: 'all' | 'finished'): Promise<CloseAgentTabsResult> {
  const candidates = agentTabInfo().filter(
    (tab) => scope === 'all' || (tab.orphaned && !tab.human),
  );
  const result = { closed: 0, failed: 0, skipped: 0 };
  for (const candidate of candidates) {
    const current = agentTabRecord(candidate.tabId);
    if (
      !current ||
      current.epoch !== candidate.epoch ||
      (scope === 'finished' && (!current.orphaned || current.human))
    ) {
      result.skipped++;
      continue;
    }
    try {
      await chrome.tabs.remove(candidate.tabId);
      result.closed++;
    } catch (error) {
      if (isMissingTabError(error)) result.skipped++;
      else result.failed++;
    }
  }
  return result;
}
