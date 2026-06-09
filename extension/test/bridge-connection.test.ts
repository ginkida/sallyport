/**
 * Unit tests for the BridgeConnection state machine.
 *
 * The class is dependency-injected (storage / alarms / status callback /
 * tool runner / WebSocket factory) so we can drive it without a chrome
 * environment. A `FakeWebSocket` lets each test step through the
 * open / message / close / error lifecycle deterministically.
 *
 * Two of the tests here pin real regressions caught in production:
 *
 *   - ``reconnectNow restarts a hung connect``: the old code bailed when
 *     `state === 'connecting'`, making the Reconnect button a no-op after
 *     a failed first attempt.
 *   - ``orphaned open handler does not send on closed ws``: prevents the
 *     "WebSocket is already in CLOSING or CLOSED state" crash when a
 *     stale handler from a torn-down WS fired.
 */

import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { BridgeConnection, type Deps, type StatusSnapshot } from '../src/bridge-connection.js';
import { Signer } from '../src/crypto.js';
import { canonicalJson } from '../src/protocol.js';

const SECRET_BYTES = new Uint8Array(32);
const SECRET_B64 = Buffer.from(SECRET_BYTES).toString('base64');

// ---------------------------------------------------------------------------
// FakeWebSocket — lets tests open/close/message at will.
// ---------------------------------------------------------------------------

type Listener<T = unknown> = (evt: T) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState: number = 0; // CONNECTING
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('WebSocket is not OPEN');
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire('close', new Event('close'));
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire('open', new Event('open'));
  }

  simulateMessage(text: string): void {
    this.fire('message', { data: text } as MessageEvent);
  }

  simulateError(): void {
    this.fire('error', new Event('error'));
  }

  simulateClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire('close', new Event('close'));
  }

  private fire(type: string, evt: unknown): void {
    for (const l of this.listeners[type] ?? []) {
      l(evt);
    }
  }
}

// ---------------------------------------------------------------------------
// FakeStorage / alarms / deps
// ---------------------------------------------------------------------------

function makeStorage(initial: {
  secret?: string;
  serverUrl?: string;
  paused?: boolean;
}): Deps['storage'] {
  let secret = initial.secret ?? null;
  let settings = { serverUrl: initial.serverUrl ?? 'ws://x/ws', paused: !!initial.paused };
  return {
    async getSecret() {
      return secret;
    },
    async setSecret(b64: string) {
      secret = b64;
    },
    async clearSecret() {
      secret = null;
    },
    async getSettings() {
      return { ...settings };
    },
    async setSettings(patch) {
      settings = { ...settings, ...patch };
    },
  };
}

function makeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps;
  statusLog: StatusSnapshot[];
  alarmCalls: { create: string[]; clear: string[] };
} {
  FakeWebSocket.instances = [];
  const statusLog: StatusSnapshot[] = [];
  const alarmCalls = { create: [] as string[], clear: [] as string[] };

  const deps: Deps = {
    storage: makeStorage({ secret: SECRET_B64 }),
    alarms: {
      create: (name) => alarmCalls.create.push(name),
      clear: (name) => alarmCalls.clear.push(name),
    },
    onStatus: (s) => statusLog.push(s),
    runTool: async () => ({ ok: true, data: { stub: true } }),
    extensionVersion: '0.0.0-test',
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    ...overrides,
  };
  return { deps, statusLog, alarmCalls };
}

/** Build a signed envelope the way the daemon would. Re-signs are needed
 * for replay / skew tests to produce MACs the verifier accepts. */
function signEnvelope(
  type: string,
  body: unknown,
  opts: { id?: string; ts?: number; nonce?: string } = {},
): Record<string, unknown> {
  const env: Record<string, unknown> = {
    v: 1,
    ts: opts.ts ?? Math.floor(Date.now() / 1000),
    nonce: opts.nonce ?? Buffer.from(`n-${Math.random()}`).toString('base64'),
    type,
    body,
  };
  if (opts.id !== undefined) env.id = opts.id;
  const macInput = canonicalJson(env);
  const mac = createHmac('sha256', Buffer.from(SECRET_BYTES)).update(macInput).digest('base64');
  return { ...env, mac };
}

// Wait for a condition. WebCrypto-based signing/verifying takes several
// microtasks; a single setTimeout(0) isn't enough.
async function until(
  predicate: () => boolean,
  { timeoutMs = 500 }: { timeoutMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('until() timed out');
    }
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

// Short alias when we just need to drain one tick.
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BridgeConnection state — basics', () => {
  it('starts in disconnected with no_secret if storage has no secret', async () => {
    const { deps, statusLog } = makeDeps({
      storage: makeStorage({}),
    });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    expect(bridge.status().state).toBe('no_secret');
    expect(statusLog).toEqual([]); // start() doesn't push when bailing
  });

  it('reports paused state when settings.paused', async () => {
    const { deps } = makeDeps({
      storage: makeStorage({ secret: SECRET_B64, paused: true }),
    });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    expect(bridge.status().state).toBe('disconnected');
    expect(bridge.status().lastError).toBe('paused');
    expect(FakeWebSocket.instances).toHaveLength(0); // never tried to connect
  });
});

describe('BridgeConnection — connection lifecycle', () => {
  it('transitions to connected on WS open and pushes status', async () => {
    const { deps, statusLog } = makeDeps();
    const bridge = new BridgeConnection(deps);

    await bridge.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);

    expect(bridge.status().state).toBe('connected');
    expect(statusLog.at(-1)?.state).toBe('connected');
    const hello = JSON.parse(ws.sent[0]);
    expect(hello.type).toBe('hello');
    expect(hello.body.extensionVersion).toBe('0.0.0-test');
  });

  it('responds to ping with pong', async () => {
    const { deps } = makeDeps();
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1); // hello sent
    ws.sent = [];

    ws.simulateMessage(JSON.stringify(signEnvelope('ping', {})));
    await until(() => ws.sent.length === 1);

    expect(JSON.parse(ws.sent[0]).type).toBe('pong');
  });

  it('routes tool_call → runTool → tool_result', async () => {
    const runTool = vi.fn().mockResolvedValue({ ok: true, data: { tabs: [] } });
    const { deps } = makeDeps({ runTool });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];

    ws.simulateMessage(
      JSON.stringify(signEnvelope('tool_call', { name: 'list_tabs', args: {} }, { id: 'r1' })),
    );
    await until(() => ws.sent.length === 1);

    expect(runTool).toHaveBeenCalledWith('list_tabs', {});
    const out = JSON.parse(ws.sent[0]);
    expect(out.type).toBe('tool_result');
    expect(out.id).toBe('r1');
    expect(out.body).toEqual({ ok: true, data: { tabs: [] } });
  });

  it('a rejecting runTool surfaces as lastError, not an unhandled rejection', async () => {
    // In production background.ts wraps runTool so it never rejects, but
    // sendSigned (crypto) can throw. Either way the message listener must
    // catch — an unhandled rejection here would pollute the console and, in
    // strict runtimes, can tear down the worker. We simulate the failure via
    // a rejecting runTool and assert it lands in lastError and the
    // connection stays up.
    const runTool = vi.fn().mockRejectedValue(new Error('boom in tool'));
    const { deps, statusLog } = makeDeps({ runTool });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];

    ws.simulateMessage(
      JSON.stringify(signEnvelope('tool_call', { name: 'list_tabs', args: {} }, { id: 'r9' })),
    );
    await until(() => statusLog.some((s) => s.lastError?.includes('tool dispatch error')));

    expect(bridge.status().state).toBe('connected');
    expect(bridge.status().lastError).toContain('boom in tool');
    // No tool_result was sent because dispatch threw before the reply.
    expect(ws.sent).toHaveLength(0);
  });

  it('an unserialisable tool result degrades to a signed error result', async () => {
    // canonicalJson refuses NaN (the daemon could never verify the MAC).
    // Instead of sending nothing — stranding the daemon until its request
    // timeout with a misleading "extension did not reply" — the connection
    // must answer with a signed ok:false result.
    const runTool = vi.fn().mockResolvedValue({ ok: true, data: { value: NaN } });
    const { deps } = makeDeps({ runTool });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];

    ws.simulateMessage(
      JSON.stringify(signEnvelope('tool_call', { name: 'evaluate', args: {} }, { id: 'r2' })),
    );
    await until(() => ws.sent.length === 1);

    const out = JSON.parse(ws.sent[0]);
    expect(out.type).toBe('tool_result');
    expect(out.id).toBe('r2');
    expect(out.body.ok).toBe(false);
    expect(out.body.code).toBe('unserialisable_result');
    expect(out.body.error).toContain('non-finite');
    expect(bridge.status().state).toBe('connected');
  });

  it('drops frames with bad MAC silently (no echo, state preserved)', async () => {
    const { deps, statusLog } = makeDeps();
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];

    // Hand-crafted bad mac
    ws.simulateMessage(
      JSON.stringify({
        v: 1,
        ts: Math.floor(Date.now() / 1000),
        nonce: 'BBBBBBBBBBBBBBBBBBBBBB==',
        type: 'tool_call',
        id: 'evil',
        body: { name: 'list_tabs', args: {} },
        mac: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0=',
      }),
    );
    await until(() => statusLog.some((s) => s.lastError?.includes('mac')));

    expect(ws.sent).toHaveLength(0);
    expect(bridge.status().state).toBe('connected');
  });
});

describe('BridgeConnection — reconnect & backoff', () => {
  it('schedules reconnect on close and fires after the backoff delay', async () => {
    const { deps, alarmCalls } = makeDeps({ reconnectBaseMs: 10, reconnectMaxMs: 50 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws1 = FakeWebSocket.instances[0];

    ws1.simulateClose();
    // Alarm safety-net was registered.
    expect(alarmCalls.create).toEqual(['sallyport_reconnect']);
    // setTimeout(reconnectNow, ~10ms) will fire and create a fresh WS.
    await until(() => FakeWebSocket.instances.length === 2);
  });

  it('resets reconnectAttempt to 0 on a successful connect', async () => {
    // Indirect proof: with base=10ms, after several failures, the delay
    // grows. After a *successful* open the counter resets and the next
    // failure-driven retry fires within base=10ms again.
    const { deps } = makeDeps({ reconnectBaseMs: 10, reconnectMaxMs: 200 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();

    // Burn three failures in a row to push attempt up.
    for (let i = 0; i < 3; i++) {
      const wsi = FakeWebSocket.instances.at(-1)!;
      wsi.simulateClose();
      await until(() => FakeWebSocket.instances.length === i + 2);
    }

    // Now open one successfully — should reset attempt.
    const ws3 = FakeWebSocket.instances.at(-1)!;
    ws3.simulateOpen();
    await until(() => bridge.status().state === 'connected');

    // Close it again. Next retry should fire within ~10ms (base), proving
    // the counter reset.
    const lenBefore = FakeWebSocket.instances.length;
    ws3.simulateClose();
    const start = Date.now();
    await until(() => FakeWebSocket.instances.length === lenBefore + 1);
    expect(Date.now() - start).toBeLessThan(100); // well below base*2^3
  });
});

describe('BridgeConnection — Reconnect-button regressions', () => {
  it('reconnectNow restarts a hung connect (state was "connecting")', async () => {
    // Regression: reconnectNow used to bail when state was 'connecting', so
    // the popup's Reconnect button did nothing while a previous attempt was
    // still hanging.
    const { deps } = makeDeps({ reconnectBaseMs: 10 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    expect(bridge.status().state).toBe('connecting');
    const ws1 = FakeWebSocket.instances[0];

    // User clicks Reconnect while the first WS is still in CONNECTING.
    await bridge.reconnectNow();

    // The first WS was closed and a fresh one was created.
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('reconnectNow zeroes backoff so next attempt is immediate', async () => {
    const { deps } = makeDeps({ reconnectBaseMs: 10, reconnectMaxMs: 1000 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    // Burn a few failures to push attempt up.
    for (let i = 0; i < 3; i++) {
      const ws = FakeWebSocket.instances.at(-1)!;
      ws.simulateClose();
      await until(() => FakeWebSocket.instances.length === i + 2);
    }
    const before = FakeWebSocket.instances.length;

    // User-initiated Reconnect should not wait for the pending backoff.
    const start = Date.now();
    await bridge.reconnectNow();
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    expect(Date.now() - start).toBeLessThan(50); // synchronous, no backoff wait
  });

  it('orphaned open handler does not send on closed ws', async () => {
    // Regression for the "WebSocket already in CLOSING or CLOSED state"
    // crash: the open handler from a WS torn down by reconnectNow used to
    // fire and try to send hello on the dead socket.
    const { deps } = makeDeps({ reconnectBaseMs: 10 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws1 = FakeWebSocket.instances[0];

    // User clicks Reconnect while ws1 is still CONNECTING.
    await bridge.reconnectNow();
    const ws2 = FakeWebSocket.instances[1];
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);

    // Now ws1 belatedly fires 'open' — must be a no-op (orphan guard).
    ws1.simulateOpen();
    await flush();

    expect(ws1.sent).toHaveLength(0);
    // ws2 still owns the state.
    ws2.simulateOpen();
    await until(() => bridge.status().state === 'connected');
  });

  it('open handler re-checks ownership AFTER signing (reconnectNow racing the hello sign)', async () => {
    // Harder variant of the orphan guard: the guard at the top of the open
    // handler passes, but reconnectNow() fires *during* the await on
    // signer.sign(). The stale handler must re-check ownership after the
    // await and bail — not flip us to 'connected' on the dead socket and
    // clear the new socket's reconnect timer.
    const { deps } = makeDeps({ reconnectBaseMs: 10 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws1 = FakeWebSocket.instances[0];

    // Gate the FIRST hello-sign so a reconnect can interleave mid-await.
    let releaseSign!: () => void;
    const gate = new Promise<void>((r) => {
      releaseSign = r;
    });
    const realSign = Signer.prototype.sign;
    let signCalls = 0;
    let firstSignReturned = false;
    const spy = vi.spyOn(Signer.prototype, 'sign').mockImplementation(async function (
      this: Signer,
      type: string,
      body: unknown,
      id?: string,
    ) {
      signCalls += 1;
      if (signCalls === 1) {
        await gate;
        const out = await realSign.call(this, type, body, id);
        firstSignReturned = true;
        return out;
      }
      return realSign.call(this, type, body, id);
    });

    // ws1 opens → handler enters and parks on the gated sign.
    ws1.simulateOpen();
    await until(() => signCalls === 1);

    // User hits Reconnect mid-sign: ws1 is torn down, ws2 installed.
    await bridge.reconnectNow();
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Release ws1's now-orphaned hello sign. With the post-await re-check the
    // stale handler bails; without it, it would set state='connected'.
    releaseSign();
    await until(() => firstSignReturned);
    await flush();

    expect(ws1.sent).toHaveLength(0);
    expect(bridge.status().state).toBe('connecting'); // ws2 still owns the slot

    spy.mockRestore();

    // ws2 completes the handshake normally.
    const ws2 = FakeWebSocket.instances[1];
    ws2.simulateOpen();
    await until(() => bridge.status().state === 'connected');
  });
});

describe('BridgeConnection — small surface paths', () => {
  it('error event sets lastError when not yet connected', async () => {
    const { deps, statusLog } = makeDeps({ reconnectBaseMs: 10 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateError(); // before open
    expect(bridge.status().lastError).toBe('connection error');
    // No state change pushed by error itself; status pushed on close.
    expect(statusLog.length).toBeGreaterThanOrEqual(0);
  });

  it('hello_ack and unknown signed types are accepted but no-op', async () => {
    const { deps } = makeDeps();
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];

    ws.simulateMessage(JSON.stringify(signEnvelope('hello_ack', {})));
    ws.simulateMessage(JSON.stringify(signEnvelope('some_future_type', { foo: 'bar' })));
    await flush();
    // Neither produces a send; state preserved.
    expect(ws.sent).toHaveLength(0);
    expect(bridge.status().state).toBe('connected');
  });

  it('onAlarm forwards to reconnectNow', async () => {
    const { deps } = makeDeps({ reconnectBaseMs: 10 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws1 = FakeWebSocket.instances[0];
    ws1.simulateClose();
    await flush();

    await bridge.onAlarm();
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('non-JSON frames are ignored without sending anything', async () => {
    const { deps } = makeDeps();
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];

    ws.simulateMessage('not even { JSON }');
    await flush();
    expect(ws.sent).toHaveLength(0);
    expect(bridge.status().state).toBe('connected');
  });

  it('tool_call without id is dropped (no response)', async () => {
    const runTool = vi.fn().mockResolvedValue({ ok: true, data: null });
    const { deps } = makeDeps({ runTool });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];

    ws.simulateMessage(JSON.stringify(signEnvelope('tool_call', { name: 'list_tabs', args: {} })));
    await flush();
    expect(ws.sent).toHaveLength(0); // no id → no reply
    expect(runTool).not.toHaveBeenCalled();
  });
});

describe('BridgeConnection — pair / unpair / pause / resume', () => {
  it('pair stores secret and starts a connection', async () => {
    const storage = makeStorage({});
    const { deps } = makeDeps({ storage });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    expect(bridge.status().state).toBe('no_secret');

    await bridge.pair(SECRET_B64);
    expect(await storage.getSecret()).toBe(SECRET_B64);
    expect(bridge.status().state).toBe('connecting');
  });

  it('pair rejects an invalid base64 secret', async () => {
    const { deps } = makeDeps({ storage: makeStorage({}) });
    const bridge = new BridgeConnection(deps);
    await expect(bridge.pair('!!!not-base64!!!')).rejects.toThrow();
  });

  it('unpair clears the secret and stops reconnecting', async () => {
    const storage = makeStorage({ secret: SECRET_B64 });
    const { deps } = makeDeps({ storage });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    await bridge.unpair();
    expect(await storage.getSecret()).toBeNull();
    expect(bridge.status().state).toBe('no_secret');
  });

  it('pause stops the connection, resume restarts', async () => {
    const storage = makeStorage({ secret: SECRET_B64 });
    const { deps } = makeDeps({ storage });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    FakeWebSocket.instances[0].simulateOpen();

    await bridge.pause();
    expect((await storage.getSettings()).paused).toBe(true);
    expect(bridge.status().state).toBe('disconnected');
    expect(bridge.status().lastError).toBe('paused');

    await bridge.resume();
    expect((await storage.getSettings()).paused).toBe(false);
    // resume calls start() which calls connect(); state goes to 'connecting'.
    expect(bridge.status().state).toBe('connecting');
  });
});
