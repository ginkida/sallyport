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
import {
  ALARM_KEEPALIVE,
  BridgeConnection,
  RECONNECT_MAX_MS,
  type Deps,
  type StatusSnapshot,
} from '../src/bridge-connection.js';
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
    // start() registered the recurring keep-alive alarm; close() added the
    // one-shot reconnect-backoff alarm safety-net.
    expect(alarmCalls.create).toContain('sallyport_keepalive');
    expect(alarmCalls.create).toContain('sallyport_reconnect');
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

  it('caps the reconnect-backoff constant short for the loopback daemon', () => {
    // Guard against re-raising the cap (30s left the popup looking dead long
    // after a sub-second daemon restart).
    expect(RECONNECT_MAX_MS).toBeLessThanOrEqual(5000);
  });

  it('clamps backoff growth at the cap once the exponential overshoots it', async () => {
    // base=10, max=30: the uncapped delay at attempt≥6 is ≥640ms. Proving the
    // next retry fires well under that exercises Math.min(max, base*2**n) — the
    // actual clamp — not just the constant. Without the clamp this would hang
    // past the assertion (640ms) and fail.
    const { deps } = makeDeps({ reconnectBaseMs: 10, reconnectMaxMs: 30 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    for (let i = 0; i < 6; i++) {
      const wsi = FakeWebSocket.instances.at(-1)!;
      wsi.simulateClose();
      await until(() => FakeWebSocket.instances.length === i + 2);
    }
    const before = FakeWebSocket.instances.length;
    const start = Date.now();
    FakeWebSocket.instances.at(-1)!.simulateClose();
    await until(() => FakeWebSocket.instances.length === before + 1);
    expect(Date.now() - start).toBeLessThan(300); // clamped to ~30ms, not 640ms
  });
});

describe('BridgeConnection — keep-alive', () => {
  it('registers the keep-alive alarm on start and clears it on disconnect', async () => {
    const { deps, alarmCalls } = makeDeps();
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    expect(alarmCalls.create).toContain(ALARM_KEEPALIVE);
    await bridge.disconnect();
    expect(alarmCalls.clear).toContain(ALARM_KEEPALIVE);
  });

  it('pings on a fixed cadence while connected', async () => {
    const { deps } = makeDeps({ keepaliveIntervalMs: 20 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1); // hello
    ws.sent = [];
    await until(() => ws.sent.length >= 1);
    expect(JSON.parse(ws.sent[0]).type).toBe('ping');
  });

  it('stops pinging once the socket closes', async () => {
    const { deps } = makeDeps({
      keepaliveIntervalMs: 20,
      reconnectBaseMs: 100000,
      reconnectMaxMs: 100000,
    });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.simulateClose();
    ws.sent = [];
    await new Promise<void>((r) => setTimeout(r, 80)); // several ping intervals
    expect(ws.sent).toHaveLength(0);
  });

  it('accepts an inbound pong with no reply, state preserved', async () => {
    const { deps } = makeDeps({ keepaliveIntervalMs: 100000 }); // suppress auto-ping
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];
    ws.simulateMessage(JSON.stringify(signEnvelope('pong', {})));
    await flush();
    expect(ws.sent).toHaveLength(0);
    expect(bridge.status().state).toBe('connected');
  });

  it('onKeepaliveAlarm pings when connected', async () => {
    const { deps } = makeDeps({ keepaliveIntervalMs: 100000 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);
    ws.sent = [];
    await bridge.onKeepaliveAlarm();
    await until(() => ws.sent.length === 1);
    expect(JSON.parse(ws.sent[0]).type).toBe('ping');
  });

  it('onKeepaliveAlarm resurrects a connection whose backoff timer was lost', async () => {
    // Models a worker suspended while connected: the socket died but the
    // setTimeout backoff is far out (here: never within the test). The
    // recurring keep-alive alarm is the backstop that reconnects.
    const { deps } = makeDeps({ reconnectBaseMs: 100000, reconnectMaxMs: 100000 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    FakeWebSocket.instances[0].simulateOpen();
    await until(() => bridge.status().state === 'connected');
    FakeWebSocket.instances[0].simulateClose();
    const before = FakeWebSocket.instances.length;
    await bridge.onKeepaliveAlarm();
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('onKeepaliveAlarm short-circuits on a paused cold start (never started)', async () => {
    // start() bailed before setting shouldReconnect, so the alarm returns at
    // the shouldReconnect check without entering the retry path.
    const { deps } = makeDeps({ storage: makeStorage({ secret: SECRET_B64, paused: true }) });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const before = FakeWebSocket.instances.length;
    await bridge.onKeepaliveAlarm();
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  it('onKeepaliveAlarm honours a pause that landed after a drop (in-flight guard)', async () => {
    // Drives the paused guard *inside* _attemptReconnect: shouldReconnect is
    // true (we were connected), the socket dropped, then storage flips to
    // paused. The alarm-driven retry must not open a rival socket.
    const storage = makeStorage({ secret: SECRET_B64 });
    const { deps } = makeDeps({ storage, reconnectBaseMs: 100000, reconnectMaxMs: 100000 });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    FakeWebSocket.instances[0].simulateOpen();
    await until(() => bridge.status().state === 'connected');

    FakeWebSocket.instances[0].simulateClose(); // shouldReconnect stays true
    await storage.setSettings({ paused: true });
    const before = FakeWebSocket.instances.length;
    await bridge.onKeepaliveAlarm();
    expect(FakeWebSocket.instances.length).toBe(before);
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
    const { deps, alarmCalls } = makeDeps({ storage });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    FakeWebSocket.instances[0].simulateOpen();

    await bridge.pause();
    expect((await storage.getSettings()).paused).toBe(true);
    expect(bridge.status().state).toBe('disconnected');
    expect(bridge.status().lastError).toBe('paused');
    // pause() routes through disconnect() and must stop the recurring keep-alive
    // alarm — otherwise the worker keeps waking while the user expects it idle.
    expect(alarmCalls.clear).toContain(ALARM_KEEPALIVE);

    alarmCalls.create.length = 0; // ignore the start()-time registration
    await bridge.resume();
    expect((await storage.getSettings()).paused).toBe(false);
    // resume calls start() which calls connect(); state goes to 'connecting'.
    expect(bridge.status().state).toBe('connecting');
    // resume() must re-register the keep-alive alarm via start().
    expect(alarmCalls.create).toContain(ALARM_KEEPALIVE);
  });
});

// ---------------------------------------------------------------------------
// Stale-guard races: state checked before an await, mutated during it.
// Same class as the 'open'-handler ownership re-check fixed in 0.3.2.
// ---------------------------------------------------------------------------

describe('BridgeConnection — stale-guard races across awaits', () => {
  it('pause() landing during start() wins — bridge must not end up connected while paused', async () => {
    const { deps } = makeDeps();
    const bridge = new BridgeConnection(deps);
    // start() parks on its storage awaits; pause() interleaves. Before the
    // fix, start() resumed with a stale settings snapshot, connected anyway,
    // and the bridge ran tools while settings.paused was true.
    const startP = bridge.start();
    const pauseP = bridge.pause();
    await Promise.all([startP, pauseP]);
    for (const ws of FakeWebSocket.instances) ws.simulateOpen();
    await flush();
    expect(bridge.status().state).toBe('disconnected');
    expect(bridge.status().lastError).toBe('paused');
    expect(FakeWebSocket.instances.every((ws) => ws.sent.length === 0)).toBe(true);
  });

  it('unpair() landing during start() does not resurrect the cleared secret', async () => {
    const { deps } = makeDeps();
    const bridge = new BridgeConnection(deps);
    // start() read the secret into a local before unpair() cleared storage
    // and the signer. Before the fix, start() resumed, re-imported that
    // stale local into the signer and reconnected as if still paired.
    const startP = bridge.start();
    const unpairP = bridge.unpair();
    await Promise.all([startP, unpairP]);
    for (const ws of FakeWebSocket.instances) ws.simulateOpen();
    await flush();
    expect(bridge.status().state).toBe('no_secret');
    expect(FakeWebSocket.instances.every((ws) => ws.sent.length === 0)).toBe(true);
  });

  it('a scheduled retry resumed after a successful connect does not stomp the live socket', async () => {
    const base = makeStorage({ secret: SECRET_B64 });
    let defer = false;
    const parked: Array<() => void> = [];
    const storage: Deps['storage'] = {
      ...base,
      async getSettings() {
        if (defer) await new Promise<void>((r) => parked.push(r));
        return base.getSettings();
      },
    };
    const { deps } = makeDeps({ storage });
    deps.reconnectBaseMs = 5;
    deps.reconnectMaxMs = 10;
    const bridge = new BridgeConnection(deps);

    await bridge.start();
    FakeWebSocket.instances[0].simulateOpen();
    await until(() => bridge.status().state === 'connected');

    // Daemon restarts: close schedules a retry; park that retry on its
    // storage read so a user reconnect can complete underneath it.
    defer = true;
    FakeWebSocket.instances[0].simulateClose();
    await until(() => parked.length === 1);

    defer = false;
    await bridge.reconnectNow();
    FakeWebSocket.instances[1].simulateOpen();
    await until(() => bridge.status().state === 'connected');

    // Un-park the stale retry. Before the fix it stomped state to
    // 'disconnected' and opened a rival socket the daemon would 1008,
    // while the live socket was orphaned out of `this.ws`.
    parked.shift()!();
    await flush();
    expect(bridge.status().state).toBe('connected');
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("an orphaned socket's late error does not stomp lastError of the new attempt", async () => {
    const { deps } = makeDeps();
    const bridge = new BridgeConnection(deps);
    await bridge.start(); // instance 0 left mid-connect
    await bridge.reconnectNow(); // tears it down, instance 1 takes over
    const [orphan, fresh] = FakeWebSocket.instances;
    orphan.simulateError();
    expect(bridge.status().lastError).toBeNull();
    fresh.simulateOpen();
    await until(() => bridge.status().state === 'connected');
  });
});

describe('broker-mode signal (hello_ack body)', () => {
  it('forwards broker:true from the hello_ack to onBrokerMode', async () => {
    const seen: boolean[] = [];
    const { deps } = makeDeps({ onBrokerMode: (b) => seen.push(b) });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1); // hello sent

    ws.simulateMessage(JSON.stringify(signEnvelope('hello_ack', { broker: true })));
    await until(() => seen.length === 1);
    expect(seen).toEqual([true]);
  });

  it('reports broker:false when the daemon omits the flag (standalone)', async () => {
    const seen: boolean[] = [];
    const { deps } = makeDeps({ onBrokerMode: (b) => seen.push(b) });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);

    ws.simulateMessage(JSON.stringify(signEnvelope('hello_ack', {})));
    await until(() => seen.length === 1);
    expect(seen).toEqual([false]);
  });

  it('a hello_ack without an onBrokerMode dep is harmless', async () => {
    const { deps } = makeDeps(); // no onBrokerMode
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1);

    ws.simulateMessage(JSON.stringify(signEnvelope('hello_ack', { broker: true })));
    await flush();
    expect(bridge.status().state).toBe('connected'); // still fine
  });

  // Regression: envelopes must be applied in ARRIVAL order. After a service
  // worker wake the daemon sends hello_ack (the broker signal) first, then a
  // tool_call. Each message's verify() awaits independently, so without in-order
  // processing the tool_call could verify first and run while brokerMode is still
  // stale — letting a tabId-less navigate clobber the human's active tab.
  it('applies hello_ack before a tool_call sent right after it, even if the tool_call verifies first', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      onBrokerMode: () => order.push('brokerMode'),
      runTool: async () => {
        order.push('runTool');
        return { ok: true, data: {} };
      },
    });
    const bridge = new BridgeConnection(deps);
    await bridge.start();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    await until(() => ws.sent.length === 1); // hello signed by the real signer

    // Swap in a signer that makes the hello_ack verify SLOWER than the
    // tool_call's. Without in-order processing the tool_call wins the race and
    // runs before brokerMode is set; with it, the chain guarantees the order.
    (bridge as unknown as { signer: unknown }).signer = {
      async verify(raw: { type: string }) {
        if (raw.type === 'hello_ack') await new Promise((r) => setTimeout(r, 20));
        return raw;
      },
      hasSecret: () => true,
      async sign(type: string, body: unknown, id?: string) {
        return { v: 1, ts: 0, nonce: 'n', type, body, id, mac: 'x' };
      },
    };

    ws.simulateMessage(JSON.stringify({ type: 'hello_ack', body: { broker: true } }));
    ws.simulateMessage(
      JSON.stringify({ type: 'tool_call', id: 'r1', body: { name: 'snapshot', args: {} } }),
    );

    await until(() => order.includes('runTool'));
    expect(order).toEqual(['brokerMode', 'runTool']);
  });
});
