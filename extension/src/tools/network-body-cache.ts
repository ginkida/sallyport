export interface CapturedBody {
  /** Response body text, capped; omitted for binary/compressed/unavailable. */
  body?: string;
  bodyTruncated?: boolean;
  /** The response finished, but its CDP body read is queued or still running. */
  bodyPending?: boolean;
  /** Body omitted due to capture pressure or the result's wire budget. Metadata
   * and size remain available; bodyOmissionReason identifies capture pressure. */
  bodyOmitted?: boolean;
  /** Metadata survives when a body read or retained-payload limit is reached. */
  bodyOmissionReason?: 'capture_busy' | 'cache_limit';
}

/** How a retained body is charged against the limits. The default counts UTF-16
 * code units × 2; network-capture.ts passes its WIRE measure so the cache and
 * the per-result budget speak one unit (see NETWORK_BODY_CACHE_PER_TAB there). */
export type BodyMeasure = (body: string) => number;

/** Bounded retention of captured response bodies across ALL tabs.
 *
 * Prefer newer responses within the caller's own tab. A busy tab must not evict
 * another tab's captured data to make room for its own response. The limits
 * describe retained payloads only — not the browser's CDP buffers, object
 * overhead or transient decoding. */
export class NetworkBodyCache {
  private retained = new Map<CapturedBody, { tabId: number; bytes: number }>();
  private byTab = new Map<number, number>();
  private used = 0;

  constructor(
    private perTabLimit: number,
    private totalLimit: number,
    private measure: BodyMeasure = (body) => body.length * 2,
  ) {}

  get bytes(): number {
    return this.used;
  }

  release(entry: CapturedBody): void {
    const record = this.retained.get(entry);
    if (!record) return;
    this.retained.delete(entry);
    this.used -= record.bytes;
    const remaining = this.byTab.get(record.tabId)! - record.bytes;
    if (remaining === 0) this.byTab.delete(record.tabId);
    else this.byTab.set(record.tabId, remaining);
    delete entry.body;
    delete entry.bodyTruncated;
  }

  retain(tabId: number, entry: CapturedBody, body: string, older: CapturedBody[]): void {
    this.release(entry);
    const bytes = this.measure(body);
    const fits = () =>
      this.used + bytes <= this.totalLimit &&
      (this.byTab.get(tabId) ?? 0) + bytes <= this.perTabLimit;
    if (bytes <= this.perTabLimit && bytes <= this.totalLimit) {
      for (const candidate of older) {
        if (fits()) break;
        if (this.retained.get(candidate)?.tabId !== tabId) continue;
        this.release(candidate);
        candidate.bodyOmitted = true;
        candidate.bodyOmissionReason = 'cache_limit';
      }
    }
    if (!fits()) {
      entry.bodyOmitted = true;
      entry.bodyOmissionReason = 'cache_limit';
      return;
    }
    entry.body = body;
    delete entry.bodyOmitted;
    delete entry.bodyOmissionReason;
    this.retained.set(entry, { tabId, bytes });
    this.byTab.set(tabId, (this.byTab.get(tabId) ?? 0) + bytes);
    this.used += bytes;
  }
}
