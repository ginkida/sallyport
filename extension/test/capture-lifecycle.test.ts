import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (source: { tabId?: number }, method: string, params?: unknown) => void;
type SettingsListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask — a drained body read's whole await chain — run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('capture lifecycle', () => {
  let listeners: Listener[];
  let settingsListeners: SettingsListener[];
  const sendCommand = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    listeners = [];
    settingsListeners = [];
    sendCommand.mockReset().mockResolvedValue({});
    vi.stubGlobal('chrome', {
      debugger: {
        sendCommand,
        detach: vi.fn().mockResolvedValue(undefined),
        onEvent: { addListener: (listener: Listener) => listeners.push(listener) },
      },
      storage: {
        onChanged: {
          addListener: (listener: SettingsListener) => settingsListeners.push(listener),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function emit(tabId: number, method: string, params: unknown) {
    for (const listener of listeners) listener({ tabId }, method, params);
  }

  function changeSettings(value: unknown, area = 'local', key = 'sallyport_settings') {
    for (const listener of settingsListeners) listener({ [key]: { newValue: value } }, area);
  }

  function response(tabId: number, requestId = 'request-1') {
    emit(tabId, 'Network.requestWillBeSent', {
      requestId,
      type: 'Fetch',
      request: { method: 'GET', url: 'https://example.com/data' },
    });
    emit(tabId, 'Network.responseReceived', {
      requestId,
      response: { status: 200, mimeType: 'application/json' },
    });
    emit(tabId, 'Network.loadingFinished', { requestId, encodedDataLength: 10 });
  }

  for (const kind of ['console', 'network'] as const) {
    async function harness() {
      if (kind === 'console') {
        const capture = await import('../src/tools/console-capture.js');
        return {
          enable: capture.ensureConsoleCapture,
          clear: capture.clearConsole,
          read: capture.readConsole,
          emit: (tabId: number) =>
            emit(tabId, 'Runtime.consoleAPICalled', {
              type: 'error',
              args: [{ value: 'message' }],
              stackTrace: { callFrames: [{ url: 'https://example.com/app.js' }] },
            }),
        };
      }
      const capture = await import('../src/tools/network-capture.js');
      return {
        enable: capture.ensureNetworkCapture,
        clear: capture.clearNetwork,
        read: capture.readNetwork,
        emit: response,
      };
    }

    it(`${kind}: ignores events before opt-in and after cleanup`, async () => {
      const capture = await harness();
      capture.emit(1);
      await Promise.resolve();
      expect(capture.read(1)).toEqual([]);
      expect(sendCommand).not.toHaveBeenCalled();

      await capture.enable(1);
      capture.emit(1);
      capture.emit(2);
      await Promise.resolve();
      expect(capture.read(1)).toHaveLength(1);
      expect(capture.read(2)).toEqual([]);

      capture.clear(1);
      capture.emit(1);
      await Promise.resolve();
      expect(capture.read(1)).toEqual([]);
    });

    it(`${kind}: a failed old enable cannot disable a new capture`, async () => {
      const capture = await harness();
      const old = deferred<object>();
      sendCommand.mockReturnValueOnce(old.promise);
      const first = capture.enable(1);
      capture.clear(1);
      await capture.enable(1);
      old.reject(new Error('old attachment gone'));
      await first;
      await capture.enable(1);
      expect(sendCommand).toHaveBeenCalledTimes(2);
      capture.emit(1);
      await Promise.resolve();
      expect(capture.read(1)).toHaveLength(1);
    });

    it(`${kind}: failed enable discards replayed events and allows retry`, async () => {
      const capture = await harness();
      const enabling = deferred<object>();
      sendCommand.mockReturnValueOnce(enabling.promise);
      const first = capture.enable(1);
      capture.emit(1);
      await Promise.resolve();
      enabling.reject(new Error('enable failed'));
      await first;
      expect(capture.read(1)).toEqual([]);
      await capture.enable(1);
      capture.emit(1);
      await Promise.resolve();
      expect(capture.read(1)).toHaveLength(1);
    });

    it(`${kind}: opt-out clears idle tabs and rejects an attach with stale settings`, async () => {
      const capture = await harness();
      (await import('../src/tools/capture-settings.js')).installCaptureSettingsListener();
      await capture.enable(1);
      await capture.enable(2);
      capture.emit(1);
      capture.emit(2);
      await Promise.resolve();
      expect(capture.read(1)).toHaveLength(1);
      expect(capture.read(2)).toHaveLength(1);
      changeSettings({
        captureConsole: true,
        captureNetwork: true,
        [`capture${kind === 'console' ? 'Console' : 'Network'}`]: false,
      });
      expect(capture.read(1)).toEqual([]);
      expect(capture.read(2)).toEqual([]);
      sendCommand.mockClear();
      await capture.enable(1);
      capture.emit(1);
      await Promise.resolve();
      expect(sendCommand).not.toHaveBeenCalled();
      expect(capture.read(1)).toEqual([]);

      changeSettings({ captureConsole: true, captureNetwork: true });
      expect(sendCommand).not.toHaveBeenCalled();
      await capture.enable(1);
      capture.emit(1);
      await Promise.resolve();
      expect(capture.read(1)).toHaveLength(1);
    });

    it(`${kind}: unrelated storage events preserve capture, removing settings revokes it`, async () => {
      const capture = await harness();
      (await import('../src/tools/capture-settings.js')).installCaptureSettingsListener();
      await capture.enable(1);
      changeSettings({}, 'session');
      changeSettings({}, 'local', 'sallyport_audit');
      capture.emit(1);
      await Promise.resolve();
      expect(capture.read(1)).toHaveLength(1);
      changeSettings(undefined);
      expect(capture.read(1)).toEqual([]);
      await capture.enable(1);
      capture.emit(1);
      await Promise.resolve();
      expect(capture.read(1)).toEqual([]);
    });
  }

  it.each([false, true])(
    'discards an old response body after cleanup (re-enabled: %s)',
    async (reenable) => {
      const capture = await import('../src/tools/network-capture.js');
      await capture.ensureNetworkCapture(1);
      const body = deferred<object>();
      sendCommand.mockReturnValueOnce(body.promise);
      response(1);
      capture.clearNetwork(1);
      if (reenable) await capture.ensureNetworkCapture(1);
      body.resolve({ body: 'old private data', base64Encoded: false });
      await Promise.resolve();
      expect(capture.readNetwork(1)).toEqual([]);
      if (reenable) {
        sendCommand.mockResolvedValue({ body: 'new data', base64Encoded: false });
        response(1);
        await Promise.resolve();
        expect(capture.readNetwork(1).map((entry) => entry.body)).toEqual(['new data']);
      }
    },
  );

  it('opt-out invalidates a pending body even if capture is turned back on', async () => {
    const capture = await import('../src/tools/network-capture.js');
    (await import('../src/tools/capture-settings.js')).installCaptureSettingsListener();
    await capture.ensureNetworkCapture(1);
    const body = deferred<object>();
    sendCommand.mockReturnValueOnce(body.promise);
    response(1);
    changeSettings({ captureNetwork: false });
    changeSettings({ captureNetwork: true });
    await capture.ensureNetworkCapture(1);
    body.resolve({ body: 'old private data' });
    await Promise.resolve();
    expect(capture.readNetwork(1)).toEqual([]);
  });

  it('queues body reads past the per-tab limit instead of dropping them, without blocking another tab', async () => {
    const capture = await import('../src/tools/network-capture.js');
    await capture.ensureNetworkCapture(1);
    await capture.ensureNetworkCapture(2);
    sendCommand.mockClear();
    const bodies = Array.from({ length: capture.NETWORK_MAX_BODY_READS_PER_TAB }, () =>
      deferred<object>(),
    );
    for (const [i, body] of bodies.entries()) {
      sendCommand.mockReturnValueOnce(body.promise);
      response(1, `request-${i}`);
    }
    response(1, 'queued');
    // The fifth read WAITS — it is neither started nor written off.
    expect(sendCommand).toHaveBeenCalledTimes(capture.NETWORK_MAX_BODY_READS_PER_TAB);
    expect(capture.readNetwork(1).at(-1)).toMatchObject({ bodyPending: true, status: 200 });
    expect(capture.readNetwork(1).at(-1)?.bodyOmitted).toBeUndefined();
    // Another tab is not held up by tab 1's queue.
    response(2);
    await Promise.resolve();
    expect(capture.readNetwork(2)).toHaveLength(1);
    expect(capture.readNetwork(2)[0].bodyOmitted).toBeUndefined();

    // A slot frees (even by failure) → the queued read runs and lands its body.
    sendCommand.mockResolvedValue({ body: 'queued body' });
    bodies[0].reject(new Error('body evicted'));
    await flush();
    // 4 for tab 1's first wave, 1 for tab 2, and now the drained fifth.
    expect(sendCommand).toHaveBeenCalledTimes(capture.NETWORK_MAX_BODY_READS_PER_TAB + 2);
    expect(capture.readNetwork(1).at(-1)).toMatchObject({ body: 'queued body' });
    expect(capture.readNetwork(1).at(-1)?.bodyPending).toBeUndefined();
    for (const body of bodies.slice(1)) body.resolve({ body: 'earlier' });
    await flush();
    expect(capture.readNetwork(1).filter((entry) => entry.body === 'earlier')).toHaveLength(
      capture.NETWORK_MAX_BODY_READS_PER_TAB - 1,
    );
  });

  it('reads a whole burst of simultaneous responses, in order, with only the concurrency capped', async () => {
    // The dashboard case: many widget XHRs finish before the first body read
    // returns. Every body must still arrive.
    const capture = await import('../src/tools/network-capture.js');
    await capture.ensureNetworkCapture(1);
    sendCommand.mockClear();
    sendCommand.mockImplementation(async (_target: unknown, _method: string, params: unknown) => ({
      body: `body of ${(params as { requestId: string }).requestId}`,
    }));
    const burst = 3 * capture.NETWORK_MAX_BODY_READS_PER_TAB;
    for (let i = 0; i < burst; i++) response(1, `widget-${i}`);
    expect(sendCommand).toHaveBeenCalledTimes(capture.NETWORK_MAX_BODY_READS_PER_TAB);
    await flush();
    expect(sendCommand).toHaveBeenCalledTimes(burst);
    const rows = capture.readNetwork(1);
    expect(rows.map((row) => row.body)).toEqual(
      Array.from({ length: burst }, (_, i) => `body of widget-${i}`),
    );
    expect(rows.some((row) => row.bodyOmitted || row.bodyPending)).toBe(false);
  });

  it("answers capture_busy only when a tab's queue itself overflows, and skips reads for evicted entries", async () => {
    const capture = await import('../src/tools/network-capture.js');
    await capture.ensureNetworkCapture(1);
    sendCommand.mockClear();
    const inFlight = Array.from({ length: capture.NETWORK_MAX_BODY_READS_PER_TAB }, () =>
      deferred<object>(),
    );
    for (const [i, body] of inFlight.entries()) {
      sendCommand.mockReturnValueOnce(body.promise);
      response(1, `inflight-${i}`);
    }
    for (let i = 0; i < capture.NETWORK_MAX_QUEUED_BODY_READS; i++) response(1, `queued-${i}`);
    response(1, 'overflow');
    const rows = capture.readNetwork(1);
    expect(rows).toHaveLength(capture.NETWORK_MAX_ENTRIES);
    expect(rows.at(-1)).toMatchObject({ bodyOmitted: true, bodyOmissionReason: 'capture_busy' });
    expect(rows.at(-2)).toMatchObject({ bodyPending: true });
    expect(sendCommand).toHaveBeenCalledTimes(capture.NETWORK_MAX_BODY_READS_PER_TAB);

    // Draining: entries the ring evicted while they waited are never read;
    // everything still in the ring gets its body.
    sendCommand.mockResolvedValue({ body: 'late' });
    for (const body of inFlight) body.resolve({ body: 'first' });
    await flush();
    const after = capture.readNetwork(1);
    const stillQueuedInRing = after.filter((row) => row.url && !row.bodyOmitted).length;
    expect(sendCommand).toHaveBeenCalledTimes(
      capture.NETWORK_MAX_BODY_READS_PER_TAB + stillQueuedInRing,
    );
    expect(after.slice(0, -1).every((row) => row.body === 'late')).toBe(true);
    expect(after.some((row) => row.bodyPending)).toBe(false);
  });

  it('retains the global read limit across cleanup and drains the queue when old calls finish', async () => {
    const capture = await import('../src/tools/network-capture.js');
    const bodies = Array.from({ length: capture.NETWORK_MAX_BODY_READS }, () => deferred<object>());
    const tabCount = Math.ceil(
      capture.NETWORK_MAX_BODY_READS / capture.NETWORK_MAX_BODY_READS_PER_TAB,
    );
    for (let tab = 0; tab <= tabCount; tab++) await capture.ensureNetworkCapture(tab);
    sendCommand.mockClear();
    for (const [i, body] of bodies.entries()) {
      sendCommand.mockReturnValueOnce(body.promise);
      response(Math.floor(i / capture.NETWORK_MAX_BODY_READS_PER_TAB), `request-${i}`);
    }
    for (let tab = 0; tab < tabCount; tab++) capture.clearNetwork(tab);
    response(tabCount, 'waiting');
    // Cleanup does not free slots Chrome has not answered yet: the new read waits.
    expect(sendCommand).toHaveBeenCalledTimes(capture.NETWORK_MAX_BODY_READS);
    expect(capture.readNetwork(tabCount)[0]).toMatchObject({ bodyPending: true });
    sendCommand.mockResolvedValue({ body: 'available again' });
    for (const body of bodies) body.resolve({ body: 'discarded' });
    await flush();
    for (let tab = 0; tab < tabCount; tab++) expect(capture.readNetwork(tab)).toEqual([]);
    expect(capture.readNetwork(tabCount)[0]?.body).toBe('available again');
  });

  it('keeps completion order and returns snapshots unaffected by later body reads', async () => {
    const capture = await import('../src/tools/network-capture.js');
    await capture.ensureNetworkCapture(1);
    const first = deferred<object>();
    const second = deferred<object>();
    sendCommand.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    response(1, 'first');
    response(1, 'second');
    const snapshot = capture.readNetwork(1);
    expect(snapshot.map((entry) => entry.bodyPending)).toEqual([true, true]);
    second.resolve({ body: 'second' });
    await Promise.resolve();
    first.resolve({ body: 'first' });
    await Promise.resolve();
    expect(capture.readNetwork(1).map((entry) => entry.body)).toEqual(['first', 'second']);
    expect(capture.readNetwork(1).some((entry) => entry.bodyPending)).toBe(false);
    expect(snapshot.map((entry) => entry.body)).toEqual([undefined, undefined]);
  });

  it('does not resurrect a ring entry evicted while its body was pending', async () => {
    const capture = await import('../src/tools/network-capture.js');
    await capture.ensureNetworkCapture(1);
    const old = deferred<object>();
    sendCommand.mockReturnValueOnce(old.promise);
    response(1, 'old');
    for (let i = 0; i < capture.NETWORK_MAX_ENTRIES; i++) {
      response(1, `new-${i}`);
      await Promise.resolve();
    }
    old.resolve({ body: 'evicted' });
    await Promise.resolve();
    expect(capture.readNetwork(1)).toHaveLength(capture.NETWORK_MAX_ENTRIES);
    expect(capture.readNetwork(1).some((entry) => entry.body === 'evicted')).toBe(false);
  });

  it('bounds retained bodies across tabs in WIRE bytes and releases capacity on cleanup', async () => {
    const capture = await import('../src/tools/network-capture.js');
    // NETWORK_MAX_BODY wire bytes each (the two JSON quotes included), so the
    // per-tab and total caps divide evenly and the arithmetic below is exact.
    const payload = 'x'.repeat(capture.NETWORK_MAX_BODY - 2);
    const perBody = capture.bodyWireBytes(payload);
    expect(perBody).toBe(capture.NETWORK_MAX_BODY);
    const perTab = capture.NETWORK_BODY_CACHE_PER_TAB / perBody;
    const tabCount = capture.NETWORK_BODY_CACHE_TOTAL / capture.NETWORK_BODY_CACHE_PER_TAB;
    expect(Number.isInteger(perTab) && Number.isInteger(tabCount)).toBe(true);
    for (let tab = 0; tab <= tabCount; tab++) await capture.ensureNetworkCapture(tab);
    sendCommand.mockResolvedValue({ body: payload });
    for (let tab = 0; tab < tabCount; tab++) {
      for (let i = 0; i < perTab + 1; i++) {
        response(tab, `request-${i}`);
        await Promise.resolve();
      }
      const rows = capture.readNetwork(tab);
      expect(rows[0].bodyOmissionReason).toBe('cache_limit');
      expect(rows.reduce((sum, row) => sum + (row.body ? perBody : 0), 0)).toBe(
        capture.NETWORK_BODY_CACHE_PER_TAB,
      );
    }
    response(tabCount);
    await Promise.resolve();
    expect(capture.readNetwork(tabCount)[0].bodyOmissionReason).toBe('cache_limit');
    const beforeCleanup = capture.readNetwork(0);
    capture.clearNetwork(0);
    response(tabCount, 'after-cleanup');
    await Promise.resolve();
    expect(capture.readNetwork(tabCount).at(-1)?.body).toBe(payload);
    expect(beforeCleanup.at(-1)?.body).toBe(payload); // old results are immutable snapshots
  });

  it.each([false, true])(
    'explicit detach cleans state without an onDetach event (already gone: %s)',
    async (alreadyGone) => {
      const capture = await import('../src/tools/network-capture.js');
      const consoleCapture = await import('../src/tools/console-capture.js');
      const cdp = await import('../src/tools/cdp.js');
      await capture.ensureNetworkCapture(1);
      await consoleCapture.ensureConsoleCapture(1);
      response(1);
      emit(1, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'old log' }] });
      await Promise.resolve();
      cdp.recordEmulatedDsf(1, 2);
      expect(capture.readNetwork(1)).toHaveLength(1);
      expect(consoleCapture.readConsole(1)).toHaveLength(1);
      if (alreadyGone)
        vi.mocked(chrome.debugger.detach).mockRejectedValueOnce(new Error('not attached'));
      await cdp.detach(1);
      expect(capture.readNetwork(1)).toEqual([]);
      expect(consoleCapture.readConsole(1)).toEqual([]);
      expect(cdp.getEmulatedDsf(1)).toBeUndefined();
      // No browser event was emitted; the next attachment must enable again.
      sendCommand.mockClear();
      await capture.ensureNetworkCapture(1);
      expect(sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Network.enable');
    },
  );
});
