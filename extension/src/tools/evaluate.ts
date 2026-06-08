import { attach, cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureEvaluateAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import type { Tool } from './types.js';

export const evaluate: Tool = async (args) => {
  const code = String(args.code || '');
  if (!code) throw new BridgeError('bad_args', 'evaluate: code required');
  const tab = await resolveTab(args);
  await ensureEvaluateAllowed(tab.url);
  await attach(tab.id!);
  const out = await cdp<{
    result: { type: string; value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(tab.id!, 'Runtime.evaluate', {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
  });
  if (out.exceptionDetails) {
    const msg = out.exceptionDetails.exception?.description ?? out.exceptionDetails.text;
    throw new BridgeError('eval_threw', msg);
  }
  return {
    tabId: tab.id,
    url: tab.url,
    data: { type: out.result.type, value: out.result.value },
  };
};
