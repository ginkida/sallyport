import { clearRefsForTab } from './refs.js';

/** One CDP attachment per tab. Detach happens when the tab closes or the
 * user clicks "Cancel" on the debugger banner — we listen for both so the
 * set stays accurate without polling. */
const attached = new Set<number>();

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  clearRefsForTab(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attached.delete(source.tabId);
    clearRefsForTab(source.tabId);
  }
});

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (msg.includes('already attached')) {
      attached.add(tabId);
      return;
    }
    throw e;
  }
}

export async function cdp<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as unknown as T;
}
