import { decodeSecret, Signer } from './crypto.js';
import { type SignedEnvelope } from './protocol.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'no_secret';

export type StatusSnapshot = {
  state: ConnectionState;
  serverUrl: string;
  lastError: string | null;
};

export type ToolHandlerResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code?: string };
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
  /** Persist transient WS-related state via the same shape as chrome.alarms.
   * Tests pass no-op implementations; production wires real chrome.alarms. */
  alarms: {
    create(name: string, options: { delayInMinutes: number }): void;
    clear(name: string): void;
  };
  /** Called whenever the connection state changes. Production pushes via
   * chrome.runtime.sendMessage; tests can subscribe directly. */
  onStatus(snapshot: StatusSnapshot): void;
  /** Executes a tool against the page. Production wires to `runTool`. */
  runTool: ToolHandler;
  /** Extension version reported in the hello frame. */
  extensionVersion: string;
  /** WebSocket factory — production uses the global; tests inject a fake. */
  WebSocket: typeof WebSocket;
  /** Backoff overrides for tests (defaults: 1s base, 30s max). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

const ALARM_RECONNECT = 'sallyport_reconnect';
// Exponential backoff: 1s, 2s, 4s, ..., capped at MAX. Resets on a clean
// connection. Keeps us from hammering a daemon that is briefly down or
// gone for the day.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:10086/ws';

export class BridgeConnection {
  private ws: WebSocket | null = null;
  private signer = new Signer();
  private state: ConnectionState = 'disconnected';
  private currentUrl = '';
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
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

  constructor(private deps: Deps) {}

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
    this.signer.clear();
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
    await this.connect(settings.serverUrl || DEFAULT_SERVER_URL, secret, epoch);
  }

  async disconnect(): Promise<void> {
    this.epoch++; // invalidate any start()/connect() parked on an await
    this.shouldReconnect = false;
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

  /** Called by the host when a chrome.alarms wake-up fires. */
  async onAlarm(): Promise<void> {
    await this.reconnectNow();
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

    ws.addEventListener('message', async (evt: MessageEvent) => {
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
      // Awaiting it inside this listener and catching keeps a failure in tool
      // execution or signing from becoming an unhandled promise rejection —
      // mirrors the try/catch the 'open' handler already uses.
      try {
        await this.handleEnvelope(env);
      } catch (e) {
        this.lastError = 'tool dispatch error: ' + (e as Error).message;
        this.pushStatus();
      }
    });

    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.state = 'disconnected';
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

  private async handleEnvelope(env: SignedEnvelope): Promise<void> {
    switch (env.type) {
      case 'ping':
        await this.sendSigned('pong', {});
        break;
      case 'hello_ack':
        // Server confirmed pairing — nothing else to do.
        break;
      case 'tool_call':
        await this.handleToolCall(env);
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
    try {
      await this.sendSigned('tool_result', result, id);
    } catch (e) {
      // A result canonicalJson refuses to sign (NaN/Infinity, lone
      // surrogate — e.g. `evaluate` returning page-controlled data) must
      // not strand the daemon waiting out its request timeout. Degrade to
      // a signed error result; its body is plain strings, so it signs.
      await this.sendSigned(
        'tool_result',
        {
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
    this.ws.send(JSON.stringify(env));
  }

  private pushStatus(): void {
    this.deps.onStatus(this.status());
  }
}

export { ALARM_RECONNECT, RECONNECT_BASE_MS, RECONNECT_MAX_MS, DEFAULT_SERVER_URL };
