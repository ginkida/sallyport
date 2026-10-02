/**
 * The typing gates' accessibility queries are answered by the RENDERER, so a
 * busy or hung page can leave them pending forever. Unbounded, that held the
 * tab's call queue until the daemon gave up with `extension_timeout` ("may
 * still be running") for a call that typed nothing. Each query now runs under
 * a deadline — FOCUS_PROBE_DEADLINE_MS, never more than the call has left —
 * and fails CLOSED: `focus_probe_failed` before any `Input.insertText`, an
 * answer that arrives afterwards types nothing, and the attempted text is
 * redacted in the audit log like every other refusal of a typing gate.
 *
 * Chrome-mocked end to end through `runTool` (real storage, real audit log),
 * with fake timers. Each test loads fresh modules so cdp.ts's attach set and
 * hygiene timers cannot leak between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TAB = 7;
const URL_ = 'https://app.example.com/form';

type Source = { tabId?: number; sessionId?: string };
type Call = { method: string; params?: Record<string, unknown>; sessionId?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const focusedAxNode = (backendDOMNodeId: number): Record<string, unknown> => ({
  backendDOMNodeId,
  properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
});

let calls: Call[];
/** Per-method override; return `undefined` to fall through to the defaults. */
let override: (method: string, params: Record<string, unknown> | undefined, s: Source) => unknown;

function defaults(method: string): unknown {
  switch (method) {
    case 'DOM.getDocument':
      return { root: { nodeId: 1 } };
    case 'DOM.querySelector':
      return { nodeId: 7 };
    case 'DOM.resolveNode':
      return { object: { objectId: 'obj-1' } };
    case 'DOM.describeNode':
      return { node: { nodeName: 'INPUT', backendNodeId: 5, attributes: ['type', 'text'] } };
    case 'Runtime.callFunctionOn':
      // FILL_CLEAR_FN's answer: focus landed on the target.
      return { result: { value: { tag: 'INPUT', focused: true } } };
    case 'Page.getFrameTree':
      return { frameTree: { frame: { id: 'top' } } };
    default:
      return {};
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  calls = [];
  override = () => undefined;
  const local = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (local.has(k)) out[k] = local.get(k);
          }
          return out;
        },
        async set(obj: Record<string, unknown>) {
          for (const [k, v] of Object.entries(obj)) local.set(k, v);
        },
        async remove() {},
      },
      session: {
        async get() {
          return {};
        },
        async set() {},
        async remove() {},
      },
      onChanged: { addListener() {} },
    },
    runtime: { getPlatformInfo: async () => ({ os: 'linux' }) },
    tabs: {
      async get() {
        return { id: TAB, url: URL_, title: 'form' };
      },
      onRemoved: { addListener() {} },
    },
    debugger: {
      async attach() {},
      sendCommand(source: Source, method: string, params?: Record<string, unknown>) {
        calls.push({ method, params, sessionId: source.sessionId });
        const answer = override(method, params, source);
        return Promise.resolve(answer === undefined ? defaults(method) : answer);
      },
      getTargets: async () => [],
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function load() {
  const storage = await import('../src/storage.js');
  await storage.setAllowlist([{ pattern: 'app.example.com', allowEvaluate: false, addedAt: 0 }]);
  const { runTool } = await import('../src/tools.js');
  const budget = await import('../src/tools/budget.js');
  return { runTool, getAudit: storage.getAudit, ...budget };
}

/** Start `p`, and report whether it has settled after each timer advance. */
function track(p: Promise<unknown>) {
  const state: { settled: boolean; error?: unknown; value?: unknown } = { settled: false };
  p.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const sent = (method: string) => calls.filter((c) => c.method === method);

describe('fill: an unanswered guard query fails closed', () => {
  it('refuses with focus_probe_failed at the deadline, types nothing, and redacts the value', async () => {
    const { runTool, getAudit, FOCUS_PROBE_DEADLINE_MS } = await load();
    const late = deferred<unknown>();
    override = (method) => (method === 'Accessibility.queryAXTree' ? late.promise : undefined);

    const call = track(
      runTool('fill', { tabId: TAB, selector: '#pw', value: 'hunter2', method: 'insertText' }),
    );
    await vi.advanceTimersByTimeAsync(FOCUS_PROBE_DEADLINE_MS - 1);
    expect(sent('Accessibility.queryAXTree')).toHaveLength(1);
    expect(call.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled).toBe(true);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
    expect(String((call.error as Error).message)).toMatch(/did not answer the focus check/);
    // The arm's group is released on the way out (bounded, best-effort).
    expect(
      sent('Runtime.releaseObjectGroup').some(
        (c) => c.params?.objectGroup === 'sallyport-fill-guard',
      ),
    ).toBe(true);

    // The page answers after all — saying focus IS on a plain text field. Too
    // late: the gate has thrown, so nothing may be armed or inserted.
    late.resolve({ nodes: [focusedAxNode(5)] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent('Input.insertText')).toHaveLength(0);
    expect(
      sent('Runtime.callFunctionOn').some((c) =>
        String(c.params?.functionDeclaration).includes('beforeinput'),
      ),
    ).toBe(false);

    const audit = await getAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: 'fill', ok: false });
    expect(JSON.stringify(audit)).not.toContain('hunter2');
  });

  it('does not wait on a group release the hung renderer never answers either', async () => {
    const { runTool, FOCUS_PROBE_DEADLINE_MS } = await load();
    const never = new Promise(() => {});
    override = (method, params) =>
      method === 'Accessibility.queryAXTree' ||
      (method === 'Runtime.releaseObjectGroup' && params?.objectGroup === 'sallyport-fill-guard')
        ? never
        : undefined;

    const call = track(
      runTool('fill', { tabId: TAB, selector: '#pw', value: 'hunter2', method: 'insertText' }),
    );
    await vi.advanceTimersByTimeAsync(FOCUS_PROBE_DEADLINE_MS + 1_000);
    expect(call.settled).toBe(true);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
    expect(sent('Input.insertText')).toHaveLength(0);
  });

  it('a call that answers in time is unaffected', async () => {
    const { runTool } = await load();
    override = (method, params) => {
      if (method === 'Accessibility.queryAXTree') return { nodes: [focusedAxNode(5)] };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 3 };
      if (method !== 'Runtime.callFunctionOn') return undefined;
      const fn = String(params?.functionDeclaration);
      if (fn.includes('beforeinput')) return { result: { objectId: 'guard' } };
      if (fn.includes('this.finish()')) return { result: { value: { seen: 1, blocked: 0 } } };
      return undefined;
    };
    const call = track(
      runTool('fill', { tabId: TAB, selector: '#f', value: 'abc', method: 'insertText' }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(call.settled).toBe(true);
    expect(call.error).toBeUndefined();
    expect(sent('Input.insertText')).toHaveLength(1);
  });
});

describe('key_type / send_keys: an unanswered per-frame AX walk fails closed', () => {
  it('key_type refuses at the deadline, never inserts (not even after a late answer), and redacts', async () => {
    const { runTool, getAudit, FOCUS_PROBE_DEADLINE_MS } = await load();
    const late = deferred<unknown>();
    override = (method) => (method === 'Accessibility.getFullAXTree' ? late.promise : undefined);

    const call = track(runTool('key_type', { tabId: TAB, text: 'hunter2' }));
    await vi.advanceTimersByTimeAsync(FOCUS_PROBE_DEADLINE_MS - 1);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
    // A timeout is not "this frame lives in another target": the walk must
    // not fall through to the OOPIF path and keep going.
    expect(sent('Target.getTargets')).toHaveLength(0);

    late.resolve({ nodes: [focusedAxNode(5)] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent('Input.insertText')).toHaveLength(0);
    expect(JSON.stringify(await getAudit())).not.toContain('hunter2');
  });

  it('send_keys refuses at the deadline and dispatches no key', async () => {
    const { runTool, getAudit, FOCUS_PROBE_DEADLINE_MS } = await load();
    override = (method) =>
      method === 'Accessibility.getFullAXTree' ? new Promise(() => {}) : undefined;

    const call = track(runTool('send_keys', { tabId: TAB, keys: 'h u n t e r 2' }));
    await vi.advanceTimersByTimeAsync(FOCUS_PROBE_DEADLINE_MS);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
    expect(sent('Input.dispatchKeyEvent')).toHaveLength(0);
    expect(JSON.stringify(await getAudit())).not.toContain('h u n t e r 2');
  });

  it("send_keys's per-segment re-probe is bounded too, and stops the sequence there", async () => {
    const { runTool, FOCUS_PROBE_DEADLINE_MS } = await load();
    let walks = 0;
    override = (method) => {
      if (method !== 'Accessibility.getFullAXTree') return undefined;
      walks++;
      // The up-front probe answers; the re-probe before the 2nd segment hangs.
      return walks === 1 ? { nodes: [focusedAxNode(5)] } : new Promise(() => {});
    };
    const call = track(runTool('send_keys', { tabId: TAB, keys: 'a b' }));
    await vi.advanceTimersByTimeAsync(FOCUS_PROBE_DEADLINE_MS);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
    // Only the first segment's keyDown/keyUp went out.
    expect(sent('Input.dispatchKeyEvent').map((c) => c.params?.key)).toEqual(['a', 'a']);
  });

  it("a cross-origin frame's child-session query is bounded as well", async () => {
    const { runTool, FOCUS_PROBE_DEADLINE_MS } = await load();
    override = (method, params, source) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'oopif' } }] } };
      }
      if (method === 'Accessibility.getFullAXTree' && source.sessionId === 'child') {
        return new Promise(() => {});
      }
      if (method === 'Accessibility.getFullAXTree' && params?.frameId === 'top') {
        return { nodes: [focusedAxNode(5)] };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return Promise.reject(new Error('Frame with the given frameId is not found'));
      }
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: 'oopif', type: 'iframe' }] };
      }
      if (method === 'Target.attachToTarget') return { sessionId: 'child' };
      return undefined;
    };
    const call = track(runTool('key_type', { tabId: TAB, text: 'hunter2' }));
    // The child query's deadline, then releaseChildAx's own bounded cleanup.
    await vi.advanceTimersByTimeAsync(FOCUS_PROBE_DEADLINE_MS + 1_000);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
    expect(sent('Target.detachFromTarget')).toHaveLength(1);
    expect(sent('Input.insertText')).toHaveLength(0);
  });
});

describe('the deadline never exceeds what the call has left', () => {
  it('key_type on a call with 2 s left gives up at 2 s, not 5 s', async () => {
    const { CALL_BUDGET_MS } = await load();
    const { keyType } = await import('../src/tools/keyboard.js');
    override = (method) =>
      method === 'Accessibility.getFullAXTree' ? new Promise(() => {}) : undefined;

    const startedAt = Date.now() - (CALL_BUDGET_MS - 2_000);
    const call = track(keyType({ tabId: TAB, text: 'x' }, { startedAt }));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
  });

  it('an overdrawn call sends no AX query at all and refuses at once', async () => {
    const { CALL_BUDGET_MS } = await load();
    const { keyType } = await import('../src/tools/keyboard.js');
    const startedAt = Date.now() - CALL_BUDGET_MS;
    const call = track(keyType({ tabId: TAB, text: 'x' }, { startedAt }));
    await vi.advanceTimersByTimeAsync(0);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
    expect(sent('Accessibility.getFullAXTree')).toHaveLength(0);
    expect(sent('Input.insertText')).toHaveLength(0);
  });

  it('fill on a call with 1.5 s left gives up at 1.5 s', async () => {
    const { CALL_BUDGET_MS } = await load();
    const { fill } = await import('../src/tools/dom.js');
    override = (method) =>
      method === 'Accessibility.queryAXTree' ? new Promise(() => {}) : undefined;

    const startedAt = Date.now() - (CALL_BUDGET_MS - 1_500);
    const call = track(
      fill({ tabId: TAB, selector: '#f', value: 'x', method: 'insertText' }, { startedAt }),
    );
    await vi.advanceTimersByTimeAsync(1_499);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.error).toMatchObject({ code: 'focus_probe_failed' });
    expect(sent('Input.insertText')).toHaveLength(0);
  });
});
