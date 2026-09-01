import { decodeSecret, Signer, type ReplayCacheStore } from './crypto.js';
import { type SignedEnvelope } from './protocol.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'no_secret';

export type StatusSnapshot = {
  state: ConnectionState;
  serverUrl: string;
  lastError: string | null;
};

export type ToolHandlerResult =
  { ok: true; data: unknown } | { ok: false; error: string; code?: string; detail?: unknown };
export type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolHandlerResult>;

export type StorageBackend = {
  getSecret(): Promise<string | null>;
  setSecret(b64: string): Promise<void>;
  clearSecret(): Promise<void>;
  getSettings(): Promise<{ serverUrl: string; paused: boolean }>;
  setSettings(patch: Partial<{ serverUrl: string; paused: boolean }>): Promise<void>;
};

export type Deps = {
  storage: StorageBackend;
  replayCache?: ReplayCacheStore;
  /** Persist transient WS-related state via the same shape as chrome.alarms.
   * Tests pass no-op implementations; production wires real chrome.alarms.
   * `periodInMinutes` drives the recurring keep-alive wake-up; `delayInMinutes`
   * the one-shot reconnect backoff. */
  alarms: {
    create(name: string, options: { delayInMinutes?: number; periodInMinutes?: number }): void;
    clear(name: string): void;
  };
  /** Called whenever the connection state changes. Production pushes via
   * chrome.runtime.sendMessage; tests can subscribe directly. */
  onStatus(snapshot: StatusSnapshot): void;
  /** Called when the daemon reports broker vs standalone mode in the hello_ack
   * body. Production wires it to ownership.setBrokerMode so the tool layer can
   * enable broker-only behaviours (owner-scoped list_tabs, focus mitigation);
   * tests observe directly. Optional — single-client builds may omit it. */
  onBrokerMode?: (broker: boolean) => void;
  /** Executes a tool against the page. Production wires to `runTool`. */
  runTool: ToolHandler;
  /** Extension version reported in the hello frame. */
  extensionVersion: string;
  /** WebSocket factory — production uses the global; tests inject a fake. */
  WebSocket: typeof WebSocket;
  /** Backoff overrides for tests (defaults: 1s base, 5s max). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Keep-alive ping cadence override for tests (default 20s). */
  keepaliveIntervalMs?: number;
};

const ALARM_RECONNECT = 'sallyport_reconnect';
// Recurring wake-up that keeps the MV3 service worker (and therefore the WS)
// alive while we are — or should be — connected, and resurrects it if Chrome
// suspended it anyway. See ALARM_KEEPALIVE handling in onKeepaliveAlarm().
const ALARM_KEEPALIVE = 'sallyport_keepalive';
// Exponential backoff: 1s, 2s, 4s, ..., capped at MAX. Resets on a clean
// connection. The daemon is on loopback (127.0.0.1) and its most common
// outage is a sub-second Claude-Code restart window, so the cap is kept
// short — a 30s cap left the popup looking dead long after the daemon was
// back. Backoff still grows enough to not hammer a daemon that is gone.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5000;
// Application-level ping cadence. MV3 terminates an idle service worker after
// ~30s; sending (and receiving the daemon's pong) over the WS resets that
// timer (Chrome 116+), so a 20s ping keeps both the worker and the socket
// alive between tool calls. The daemon answers `ping` with `pong`.
const KEEPALIVE_INTERVAL_MS = 20000;
// chrome.alarms' production floor is 30s; 0.5 min is the tightest recurring
// wake-up Chrome will honour.
const KEEPALIVE_ALARM_PERIOD_MIN = 0.5;

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:10086/ws';

/** Thrown by `sendSigned` when the signed frame would be refused by the
 * daemon. A marker class rather than a code string so the degrade path can tell
 * it apart from a signing failure without matching on message text. */
class OversizeFrameError extends Error {
  constructor(readonly chars: number) {
    super(`tool result is too large to send (${chars} characters)`);
  }
}

/** Ceiling on an outgoing frame, a megabyte under the daemon's own 16 MiB
 * (`bridge.py:MAX_FRAME_BYTES`).
 *
 * Being one byte over does not fail one call: `websockets` refuses the frame
 * with a 1009 close, so the daemon drops the SINGLE shared extension client
 * (invariant #8) and every concurrent session loses its in-flight work and
 * reconnects. Being a megabyte under costs nothing, so the slack is free. */
export const MAX_RESULT_FRAME_BYTES = 15 * 1024 * 1024;

/** Would this frame be refused? Exact when it matters, free when it doesn't.
 *
 * UTF-8 never spends more than 3 bytes per UTF-16 code unit (a surrogate pair
 * is 2 units and 4 bytes), so a string short enough for that bound is provably
 * fine and the encode — which would copy up to 16 MB on every tool result — is
 * skipped. Pure, so the arithmetic is unit-tested rather than trusted. */
export function exceedsFrameLimit(text: string, limit: number): boolean {
  if (text.length * 3 <= limit) return false;
  return new TextEncoder().encode(text).length > limit;
}

export class BridgeConnection {
  private ws: WebSocket | null = null;
  private signer: Signer;
  private state: ConnectionState = 'disconnected';
  private currentUrl = '';
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** Periodic ping while connected — keeps the MV3 worker + socket alive. */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  /** Session-local mirror of settings.paused. Set synchronously (before any
   * await) in pause()/resume() so an in-flight connect() observes a pause
   * that lands during one of its awaits. Storage stays authoritative across
   * service-worker restarts — start() and _attemptReconnect() read it before
   * connecting; this flag only closes the in-flight race window. */
  private paused = false;
  /** Connection-lifecycle generation. Bumped by disconnect() (and so by
   * pair/unpair/pause) and by a proceeding _attemptReconnect(). start() and
   * connect() capture it before their awaits and bail if it moved — the
   * stale-guard race class fixed for the 'open' handler in 0.3.2, applied
   * to every state check that spans an await. */
  private epoch = 0;

  constructor(private deps: Deps) {
    this.signer = new Signer(deps.replayCache);
  }

  status(): StatusSnapshot {
    return {
      state: this.state,
      serverUrl: this.currentUrl,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    const epoch = ++this.epoch;
    const settings = await this.deps.storage.getSettings();
    const secret = await this.deps.storage.getSecret();
    // pair()/unpair()/pause()/disconnect() may have run while we read
    // storage — whoever bumped the epoch owns the state now. Proceeding with
    // the stale `secret` local would, after an unpair, resurrect the cleared
    // secret into the signer and reconnect.
    if (epoch !== this.epoch) return;
    if (settings.paused) {
      this.paused = true;
      this.state = 'disconnected';
      this.lastError = 'paused';
      return;
    }
    if (!secret) {
      this.state = 'no_secret';
      this.lastError = 'no pairing secret — paste from daemon in the popup';
      return;
    }
    if (this.paused) return; // pause() raced us; it sets state/lastError itself
    this.shouldReconnect = true;
    this.ensureKeepaliveAlarm();
    await this.connect(settings.serverUrl || DEFAULT_SERVER_URL, secret, epoch);
  }

  async pair(secretB64: string, serverUrl?: string): Promise<void> {
    decodeSecret(secretB64); // throws on bad input
    await this.deps.storage.setSecret(secretB64);
    if (serverUrl) await this.deps.storage.setSettings({ serverUrl });
    await this.disconnect();
    await this.start();
  }

  async unpair(): Promise<void> {
    await this.deps.storage.clearSecret();
    await this.signer.clear();
    await this.disconnect();
    this.state = 'no_secret';
    this.lastError = null;
    this.pushStatus();
  }

  async pause(): Promise<void> {
    this.paused = true; // before the first await — closes the connect() race
    await this.deps.storage.setSettings({ paused: true });
    await this.disconnect();
    this.state = 'disconnected';
    this.lastError = 'paused';
    this.pushStatus();
  }

  async resume(): Promise<void> {
    this.paused = false;
    await this.deps.storage.setSettings({ paused: false });
    await this.start();
    this.pushStatus();
  }

  /**
   * User-initiated reconnect. Forcibly drops any in-flight WebSocket and
   * resets the backoff counter so the next attempt fires immediately.
   *
   * This used to bail when state was 'connecting' — that made the popup's
   * Reconnect button a no-op when an attempt was still hanging. The
   * regression test ``reconnectNow restarts a hung connect`` pins the fix.
   */
  async reconnectNow(): Promise<void> {
    this.reconnectAttempt = 0;
    await this._attemptReconnect({ tearDownInFlight: true });
  }

  /**
   * Internal: scheduled retry from the backoff timer or chrome.alarms.
   * Does NOT reset the attempt counter (otherwise backoff would never
   * grow), and does NOT tear down a WS that's already mid-connect.
   */
  private async _scheduledRetry(): Promise<void> {
    await this._attemptReconnect({ tearDownInFlight: false });
  }

  private async _attemptReconnect(opts: { tearDownInFlight: boolean }): Promise<void> {
    if (this.state === 'connected') return;
    if (!opts.tearDownInFlight && this.state === 'connecting') return;
    const settings = await this.deps.storage.getSettings();
    if (settings.paused) return;
    const secret = await this.deps.storage.getSecret();
    if (!secret) {
      this.state = 'no_secret';
      this.pushStatus();
      return;
    }
    // The entry guards went stale across the storage awaits (same race class
    // as the 'open'-handler ownership re-check): a connect may have started
    // or completed, or pause() may have landed, while we were reading
    // storage. Without this, a scheduled retry resumed after a successful
    // connect stomps state to 'disconnected' and opens a rival socket — the
    // daemon rejects it (1008) while the live socket is orphaned out of
    // `this.ws`, stranding every subsequent tool result.
    if (this.paused) return;
    // Re-read through a widening cast: TS keeps the entry guards' narrowing
    // of `this.state` across the awaits, but the awaits are exactly where it
    // can change.
    const state = this.state as ConnectionState;
    if (state === 'connected') return;
    if (!opts.tearDownInFlight && state === 'connecting') return;
    // Claim ownership: a connect() still parked on an await must not
    // resurrect the socket we are about to tear down.
    const epoch = ++this.epoch;
    this.clearReconnectTimer();
    if (opts.tearDownInFlight && this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
    this.state = 'disconnected';
    this.shouldReconnect = true;
    this.ensureKeepaliveAlarm();
    await this.connect(settings.serverUrl || DEFAULT_SERVER_URL, secret, epoch);
  }

  async disconnect(): Promise<void> {
    this.epoch++; // invalidate any start()/connect() parked on an await
    this.shouldReconnect = false;
    this.stopKeepalive();
    this.clearKeepaliveAlarm();
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
    this.state = 'disconnected';
  }

  /** Called by the host when the reconnect-backoff alarm fires. */
  async onAlarm(): Promise<void> {
    await this.reconnectNow();
  }

  /**
   * Called by the host when the recurring keep-alive alarm fires. Two jobs:
   *  - if we're connected, send a ping so the worker's idle timer resets even
   *    in the gap between tool calls (and a dead socket surfaces);
   *  - if we should be connected but aren't (the worker was suspended, the
   *    socket died, and no backoff timer survived the suspension), kick a
   *    reconnect. `_scheduledRetry` is a no-op while paused / already
   *    connecting, so a cold-start `start()` and this handler don't double up.
   */
  async onKeepaliveAlarm(): Promise<void> {
    if (this.state === 'connected') {
      await this.sendSigned('ping', {});
      return;
    }
    if (this.shouldReconnect) await this._scheduledRetry();
  }

  private async connect(url: string, secretB64: string, epoch: number): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') return;
    this.state = 'connecting';
    this.currentUrl = url;
    this.lastError = null;

    try {
      const secret = decodeSecret(secretB64);
      await this.signer.setSecret(secret);
    } catch (e) {
      this.state = 'no_secret';
      this.lastError = (e as Error).message;
      this.pushStatus();
      return;
    }

    // pause()/unpair()/disconnect()/reconnectNow() may have run while we
    // awaited setSecret — whoever bumped the epoch owns the state now and
    // has already put state/lastError where they want them. Creating the
    // socket anyway would reconnect a bridge the user just stopped (pause
    // case: ends 'connected' while settings.paused is true). The paused
    // check covers a pause() that has set its flag but not yet reached its
    // disconnect(); that disconnect() will settle state moments later.
    if (epoch !== this.epoch || this.paused) return;

    let ws: WebSocket;
    try {
      ws = new this.deps.WebSocket(url);
    } catch (e) {
      this.state = 'disconnected';
      this.lastError = (e as Error).message;
      this.scheduleReconnect();
      this.pushStatus();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', async () => {
      // If this WS was orphaned (e.g. user clicked Reconnect mid-connect,
      // which tore us down and started a new socket), bail out — the new
      // connection owns the state.
      if (this.ws !== ws) return;
      try {
        const env = await this.signer.sign('hello', {
          extensionVersion: this.deps.extensionVersion,
        });
        // The orphan guard above goes stale across the `await`: a
        // user-triggered reconnectNow() can tear down `ws` and install a
        // fresh socket while we were signing. Re-check ownership before
        // mutating shared state — otherwise we'd flip to 'connected' on a
        // dead socket and clearReconnectTimer() would kill the *new*
        // socket's pending retry.
        if (this.ws !== ws) return;
        if (ws.readyState === this.deps.WebSocket.OPEN) {
          ws.send(JSON.stringify(env));
        }
        this.state = 'connected';
        this.lastError = null;
        this.reconnectAttempt = 0;
        this.clearReconnectTimer();
        this.startKeepalive(ws);
        this.pushStatus();
      } catch (e) {
        this.lastError = (e as Error).message;
        try {
          ws.close();
        } catch {
          /* noop */
        }
      }
    });

    // VERIFY frames strictly in arrival order — chain each on the previous — so
    // the hello_ack's broker-mode signal is applied before any tool_call the
    // daemon sent after it. The per-message `verify()` awaits can otherwise
    // resolve out of order, dispatching a tool_call while brokerMode is still
    // stale right after a service-worker wake, which would let a tabId-less
    // navigate fall back to (and clobber) the human's active tab.
    //
    // EXECUTION of a tool_call, by contrast, is deliberately NOT chained: it is
    // started inside the ordered link and then left to run on its own. Awaiting
    // it here (as this did until 0.17) made the extension a hard serial queue
    // for every session at once — one agent's 30 s `wait_for` held up every
    // other agent's next call for its full duration, no matter what the daemon
    // did. The ordering property the chain exists for survives, because the
    // tool_call is still *started* after every earlier frame was applied.
    // `dispatchMessage` swallows its own errors, and the `.catch` is a belt so a
    // single bad frame can never break the chain for later frames.
    let inbound: Promise<void> = Promise.resolve();
    ws.addEventListener('message', (evt: MessageEvent) => {
      inbound = inbound.then(() => this.dispatchMessage(evt)).catch(() => {});
    });

    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.state = 'disconnected';
        this.stopKeepalive();
        this.pushStatus();
        if (this.shouldReconnect) this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      // An orphaned socket's late error must not stomp the lastError of the
      // attempt that replaced it.
      if (this.ws !== ws) return;
      // Chrome's WebSocket fires `error` both for genuine failures and as a
      // sibling of `close` on graceful daemon exits. Only treat it as a
      // diagnostic if we never got to `connected`.
      if (this.state !== 'connected') {
        this.lastError = 'connection error';
      }
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.deps.alarms.clear(ALARM_RECONNECT);
  }

  /** Begin pinging `ws` on a fixed cadence while it remains the live socket.
   * The interval lives only as long as the worker does; the keep-alive alarm
   * is the backstop that survives a worker suspension. */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    const interval = this.deps.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
    this.keepaliveTimer = setInterval(() => {
      if (this.ws !== ws || this.state !== 'connected') {
        this.stopKeepalive();
        return;
      }
      void this.sendSigned('ping', {});
    }, interval);
    // Under Node (the vitest harness) an unref'd interval doesn't pin the
    // process open between test runs; a no-op on the browser timer ID.
    (this.keepaliveTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private ensureKeepaliveAlarm(): void {
    this.deps.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: KEEPALIVE_ALARM_PERIOD_MIN });
  }

  private clearKeepaliveAlarm(): void {
    this.deps.alarms.clear(ALARM_KEEPALIVE);
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.clearReconnectTimer();
    const base = this.deps.reconnectBaseMs ?? RECONNECT_BASE_MS;
    const max = this.deps.reconnectMaxMs ?? RECONNECT_MAX_MS;
    const exp = Math.min(max, base * 2 ** this.reconnectAttempt);
    const jitter = Math.floor(Math.random() * Math.max(1, Math.min(250, base / 4)));
    const delay = exp + jitter;
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 10);
    this.reconnectTimer = setTimeout(() => void this._scheduledRetry(), delay);
    const alarmDelayMin = Math.max(1, Math.ceil(delay / 60000));
    this.deps.alarms.create(ALARM_RECONNECT, { delayInMinutes: alarmDelayMin });
  }

  /** Verify and route one inbound WS frame. Runs serialised through the
   * connection's `inbound` chain (see the message listener): verification and
   * every control frame — the hello_ack's brokerMode update above all —
   * complete before the next frame is looked at. A `tool_call` is STARTED here
   * and then detached, so concurrent calls from different sessions overlap
   * instead of queueing behind each other. Swallows its own errors so the chain
   * is never broken by a bad frame or a failing tool dispatch. */
  private async dispatchMessage(evt: MessageEvent): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(evt.data as string);
    } catch {
      return;
    }
    let env: SignedEnvelope;
    try {
      env = await this.signer.verify(raw);
    } catch (e) {
      this.lastError = 'mac/replay rejected: ' + (e as Error).message;
      this.pushStatus();
      return;
    }
    // `handleEnvelope` is async (it dispatches tools and signs the reply).
    // Awaiting it here and catching keeps a failure in tool execution or
    // signing from becoming an unhandled promise rejection — mirrors the
    // try/catch the 'open' handler already uses.
    try {
      await this.handleEnvelope(env);
    } catch (e) {
      this.lastError = 'tool dispatch error: ' + (e as Error).message;
      this.pushStatus();
    }
  }

  private async handleEnvelope(env: SignedEnvelope): Promise<void> {
    switch (env.type) {
      case 'ping':
        await this.sendSigned('pong', {});
        break;
      case 'pong':
        // Reply to our keep-alive ping. Receiving it already reset the
        // worker's idle timer; nothing else to do.
        break;
      case 'hello_ack':
        // Server confirmed pairing. Its body reports broker vs standalone mode;
        // surface it so the tool layer can enable broker-only behaviours.
        this.deps.onBrokerMode?.(Boolean((env.body as { broker?: unknown } | null)?.broker));
        break;
      case 'tool_call':
        // Detached on purpose (see the message listener): starting it inside
        // the ordered chain preserves "every earlier frame was applied first",
        // while not awaiting it is what lets one session's slow call run
        // alongside another session's fast one. Errors are handled inside
        // handleToolCall, which always answers the daemon; the catch is a belt
        // so a throw can never surface as an unhandled rejection.
        void this.handleToolCall(env).catch((e: unknown) => {
          this.lastError = 'tool dispatch error: ' + (e as Error).message;
          this.pushStatus();
        });
        break;
      default:
        // Unknown but signed — ignore.
        break;
    }
  }

  private async handleToolCall(env: SignedEnvelope): Promise<void> {
    const id = env.id;
    if (!id) return;
    const call = env.body as { name: string; args?: Record<string, unknown> };
    const result = await this.deps.runTool(call.name, call.args || {});
    // Deliberate non-action: we do NOT fast-fail-reconnect when a tool_result
    // send drops on a dead socket. The premise "a dropped result burns the
    // daemon's 60s request timeout" does not hold — the daemon cancels every
    // pending future the instant the client socket closes (its _handle_client
    // finally raises ExtensionNotConnected "extension disconnected
    // mid-request"), so the MCP caller is freed immediately, not after 60s.
    // Recovery is already prompt too: the WS 'close' handler schedules a 1–5s
    // reconnect, the 20s keep-alive ping surfaces a half-dead socket, and the
    // 0.5min keep-alive alarm is the suspended-worker backstop. A send-failure
    // reconnect trigger here would add another concurrent reconnect path to the
    // state machine 0.10.0 stabilised (rival-socket / orphaned this.ws class)
    // for no real gain — an in-flight result whose socket already died cannot
    // be re-delivered by reconnecting anyway (its request context died with the
    // socket). So sendSigned stays a quiet no-op on a non-OPEN socket.
    try {
      await this.sendSigned('tool_result', result, id);
    } catch (e) {
      // A result canonicalJson refuses to sign (NaN/Infinity, lone
      // surrogate — e.g. `evaluate` returning page-controlled data) must
      // not strand the daemon waiting out its request timeout. Degrade to
      // a signed error result; its body is plain strings, so it signs.
      //
      // An OVERSIZE result degrades the same way, and for a stronger reason:
      // unsent it strands one call, sent it takes down the shared connection.
      // The tools that ship bulk payloads cap themselves (screenshot, pdf,
      // fetch_in_page, snapshot); this is the backstop for the one that does
      // not yet, or the page that finds a new way to be enormous.
      const oversize = e instanceof OversizeFrameError;
      await this.sendSigned(
        'tool_result',
        oversize
          ? {
              ok: false,
              error:
                'tool result is too large for the wire (over ' +
                Math.floor(MAX_RESULT_FRAME_BYTES / (1024 * 1024)) +
                ' MiB) — narrow it: snapshot(compact:true) or a selector scope, ' +
                'read_text(maxChars), screenshot(maxWidth/region), fetch_in_page(saveAs)',
              code: 'result_too_large',
            }
          : {
              ok: false,
              error: 'tool result is not wire-serialisable: ' + (e as Error).message,
              code: 'unserialisable_result',
            },
        id,
      );
    }
  }

  private async sendSigned(type: string, body: unknown, id?: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== this.deps.WebSocket.OPEN) return;
    if (!this.signer.hasSecret()) return;
    const env = await this.signer.sign(type, body, id);
    const text = JSON.stringify(env);
    if (exceedsFrameLimit(text, MAX_RESULT_FRAME_BYTES)) {
      // Refuse it OURSELVES. Handing it to the socket is what costs the shared
      // leg; the caller degrades this to a signed error the daemon can read.
      throw new OversizeFrameError(text.length);
    }
    this.ws.send(text);
  }

  private pushStatus(): void {
    this.deps.onStatus(this.status());
  }
}

export {
  ALARM_RECONNECT,
  ALARM_KEEPALIVE,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  KEEPALIVE_INTERVAL_MS,
  DEFAULT_SERVER_URL,
};
