import { describe, expect, it } from 'vitest';

/** One tab on an allowlisted, evaluate-enabled origin; `answer` decides what
 * Runtime.evaluate does. Returns the list of CDP methods sent. */
function installChrome(answer: () => Promise<unknown>): string[] {
  const sent: string[] = [];
  const store = new Map<string, unknown>([
    ['sallyport_allowlist', [{ pattern: 'app.example.com', allowEvaluate: true, addedAt: 0 }]],
  ]);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (store.has(k)) out[k] = store.get(k);
          }
          return out;
        },
        async set(v: Record<string, unknown>) {
          for (const [k, val] of Object.entries(v)) store.set(k, val);
        },
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      async get(id: number) {
        return { id, url: 'https://app.example.com/' };
      },
      onRemoved: { addListener() {} },
    },
    debugger: {
      async attach() {},
      sendCommand: (_t: unknown, method: string) => {
        sent.push(method);
        return method === 'Runtime.evaluate' ? answer() : Promise.resolve({});
      },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  return sent;
}

const never = () => new Promise(() => {});

describe('evaluate — page code that never settles', () => {
  it('fails as evaluate_timeout at the budget and frees the tab', async () => {
    installChrome(never);
    const { evaluate } = await import('../src/tools/evaluate.js');
    const t0 = Date.now();
    await expect(
      evaluate({ code: 'await new Promise(() => {})', tabId: 5 }, { startedAt: t0 - 48_500 }),
    ).rejects.toMatchObject({ code: 'evaluate_timeout' });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('does not even send the code once the budget is spent', async () => {
    const sent = installChrome(never);
    const { evaluate } = await import('../src/tools/evaluate.js');
    await expect(
      evaluate({ code: 'doSomething()', tabId: 5 }, { startedAt: Date.now() - 49_900 }),
    ).rejects.toMatchObject({ code: 'evaluate_timeout' });
    expect(sent).not.toContain('Runtime.evaluate');
  });
});

describe('fetch_in_page — a response that never finishes', () => {
  const args = { url: 'https://app.example.com/stream', tabId: 5 };

  it('fails as fetch_timeout at the budget and frees the tab', async () => {
    installChrome(never);
    const { fetchInPage } = await import('../src/tools/fetch.js');
    const t0 = Date.now();
    await expect(fetchInPage(args, { startedAt: t0 - 48_500 })).rejects.toMatchObject({
      code: 'fetch_timeout',
    });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('does not send a request once the budget is spent — a POST must not land unseen', async () => {
    const sent = installChrome(never);
    const { fetchInPage } = await import('../src/tools/fetch.js');
    await expect(
      fetchInPage({ ...args, method: 'POST' }, { startedAt: Date.now() - 49_900 }),
    ).rejects.toMatchObject({ code: 'fetch_timeout' });
    expect(sent).not.toContain('Runtime.evaluate');
  });

  it('maps its own AbortSignal timeout to fetch_timeout, and a page error to fetch_failed', async () => {
    const { fetchInPage } = await import('../src/tools/fetch.js');
    installChrome(async () => ({
      result: { type: 'object' },
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TimeoutError: signal timed out' },
      },
    }));
    await expect(fetchInPage(args, { startedAt: Date.now() })).rejects.toMatchObject({
      code: 'fetch_timeout',
    });
    installChrome(async () => ({
      result: { type: 'object' },
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'GatewayTimeoutError: upstream 504' },
      },
    }));
    await expect(fetchInPage(args, { startedAt: Date.now() })).rejects.toMatchObject({
      code: 'fetch_failed',
      message: expect.stringContaining('GatewayTimeoutError'),
    });
  });
});
