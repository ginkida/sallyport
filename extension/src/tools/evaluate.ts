import { attach, cdp } from './cdp.js';
import { BridgeError } from './errors.js';
import { ensureEvaluateAllowed } from './gates.js';
import { resolveTab } from './tabs.js';
import { MIN_STEP_MS, raceDeadline, stepDeadlineMs } from './budget.js';
import type { Tool } from './types.js';

export const evaluate: Tool = async (args, ctx) => {
  const code = String(args.code || '');
  if (!code) throw new BridgeError('bad_args', 'evaluate: code required');
  const tab = await resolveTab(args);
  await ensureEvaluateAllowed(tab.url);
  await attach(tab.id!);
  const deadlineMs = stepDeadlineMs(ctx?.startedAt, Date.now());
  if (deadlineMs < MIN_STEP_MS) {
    throw new BridgeError(
      'evaluate_timeout',
      'evaluate: the call spent its time budget before the code was sent — nothing ran; retry',
    );
  }
  // Page code can await forever (`await new Promise(() => {})`): bound it, or
  // the per-tab call chain waits with it and every later call on the tab
  // queues behind a promise that never settles.
  const out = await raceDeadline(
    cdp<{
      result: { type: string; value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(tab.id!, 'Runtime.evaluate', {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    }),
    deadlineMs,
    () =>
      new BridgeError(
        'evaluate_timeout',
        'evaluate: the code did not settle in time (a promise that never resolves?) — the ' +
          'tab is free again; return sooner, or poll with wait_for',
      ),
  );
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
