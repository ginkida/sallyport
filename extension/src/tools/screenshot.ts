import { attach, cdp } from './cdp.js';
import { ensureAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

export const screenshot: Tool = async (args) => {
  const tab = await resolveTab(args);
  await ensureAllowed(tab.url);
  await attach(tab.id!);
  const format = args.format === 'jpeg' ? 'jpeg' : 'png';
  const params: Record<string, unknown> = { format };
  if (format === 'jpeg') params.quality = typeof args.quality === 'number' ? args.quality : 80;
  const out = await cdp<{ data: string }>(tab.id!, 'Page.captureScreenshot', params);
  return {
    tabId: tab.id,
    url: tab.url,
    data: { format, data: out.data, dataLength: out.data.length },
  };
};
