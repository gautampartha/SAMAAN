// Sequential upload queue for captured photos. Records are persisted in
// IndexedDB ("samaan-capture" / "pending") so a reload does not lose them;
// failures back off (2 s, 4 s, 8 s ... max 30 s) and the queue pauses offline.
// A module-level singleton so uploads keep running while the map page is shown.
import { useSyncExternalStore } from 'react';
import { ApiError, recomputeCoverage, uploadImage, type CaptureUpload } from './api';
import { getAll, idbAvailable, put, remove, STORE_PENDING } from './idb';

export interface PendingRecord extends CaptureUpload {
  /** IndexedDB key: captured_at + random suffix. */
  key: string;
}

export type QueueError = { kind: 'http'; status: number } | { kind: 'network'; message: string } | null;

export interface QueueState {
  /** Photos captured since the page was loaded (not persisted). */
  captured: number;
  /** Successful uploads since the page was loaded. */
  uploaded: number;
  /** Records still waiting in the queue (including those being retried). */
  pending: number;
  /** Pending records whose last attempt failed. */
  failed: number;
  uploading: boolean;
  online: boolean;
  /** True until the persisted queue has been read from IndexedDB. */
  restored: boolean;
  lastError: QueueError;
  /** Seconds until the next retry, when backing off. */
  retryInSec: number | null;
}

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const RECOMPUTE_MIN_INTERVAL_MS = 30000;

type Listener = () => void;

class UploadQueue {
  private queue: PendingRecord[] = [];
  private attempts = new Map<string, number>();
  private failedKeys = new Set<string>();
  private listeners = new Set<Listener>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt: number | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private started = false;
  private lastRecompute = 0;
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null;

  private state: QueueState = {
    captured: 0,
    uploaded: 0,
    pending: 0,
    failed: 0,
    uploading: false,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    restored: false,
    lastError: null,
    retryInSec: null,
  };

  getState = (): QueueState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Restore persisted records and attach online/offline listeners (once). */
  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    void this.restore();
  }

  private async restore(): Promise<void> {
    if (idbAvailable()) {
      try {
        const rows = await getAll<PendingRecord>(STORE_PENDING);
        rows.sort((a, b) => a.key.localeCompare(b.key));
        const known = new Set(this.queue.map((r) => r.key));
        for (const r of rows) if (!known.has(r.key)) this.queue.push(r);
      } catch (err) {
        console.warn('[queue] could not restore pending uploads', err);
      }
    }
    this.update({ restored: true });
    void this.pump();
  }

  async add(rec: CaptureUpload): Promise<void> {
    const key = `${rec.captured_at}-${Math.random().toString(36).slice(2, 10)}`;
    const record: PendingRecord = { ...rec, key };
    this.queue.push(record);
    this.update({ captured: this.state.captured + 1 });
    if (idbAvailable()) {
      try {
        await put(STORE_PENDING, record);
      } catch (err) {
        console.warn('[queue] could not persist record', err);
      }
    }
    void this.pump();
  }

  /** Drop the backoff and try the next upload immediately. */
  retryNow(): void {
    this.clearRetry();
    this.update({ online: navigator.onLine });
    void this.pump();
  }

  private onOnline = () => {
    this.update({ online: true });
    this.clearRetry();
    void this.pump();
  };

  private onOffline = () => {
    this.update({ online: false });
  };

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.retryTimer = null;
    this.tickTimer = null;
    this.retryAt = null;
    if (this.state.retryInSec !== null) this.update({ retryInSec: null });
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetry();
    this.retryAt = Date.now() + delayMs;
    this.retryTimer = setTimeout(() => {
      this.clearRetry();
      void this.pump();
    }, delayMs);
    const tick = () => {
      if (this.retryAt === null) return;
      this.update({ retryInSec: Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000)) });
    };
    tick();
    this.tickTimer = setInterval(tick, 1000);
  }

  private async pump(): Promise<void> {
    if (this.running || this.retryTimer) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        if (!navigator.onLine) {
          this.update({ online: false });
          break;
        }
        const rec = this.queue[0];
        this.update({ uploading: true });
        try {
          await uploadImage(rec);
          this.queue.shift();
          this.attempts.delete(rec.key);
          this.failedKeys.delete(rec.key);
          if (idbAvailable()) {
            try {
              await remove(STORE_PENDING, rec.key);
            } catch (err) {
              console.warn('[queue] could not delete uploaded record', err);
            }
          }
          this.update({ uploaded: this.state.uploaded + 1, lastError: null });
          this.scheduleRecompute();
        } catch (err) {
          const n = (this.attempts.get(rec.key) ?? 0) + 1;
          this.attempts.set(rec.key, n);
          this.failedKeys.add(rec.key);
          const error: QueueError =
            err instanceof ApiError
              ? { kind: 'http', status: err.status }
              : { kind: 'network', message: err instanceof Error ? err.message : String(err) };
          this.update({ lastError: error });
          // A client error (4xx other than 408/429) will not succeed on retry; move it to the
          // back so one bad record does not block the rest, but keep it for "Retry now".
          if (error.kind === 'http' && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
            this.queue.push(this.queue.shift() as PendingRecord);
          }
          this.scheduleRetry(Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS));
          break;
        }
      }
    } finally {
      this.running = false;
      this.update({ uploading: false });
    }
  }

  /** POST /coverage/recompute at most once every 30 s (trailing call), ignoring errors. */
  private scheduleRecompute(): void {
    const fire = () => {
      this.recomputeTimer = null;
      this.lastRecompute = Date.now();
      recomputeCoverage().catch(() => undefined);
    };
    const since = Date.now() - this.lastRecompute;
    if (since >= RECOMPUTE_MIN_INTERVAL_MS) fire();
    else if (!this.recomputeTimer) this.recomputeTimer = setTimeout(fire, RECOMPUTE_MIN_INTERVAL_MS - since);
  }

  private update(patch: Partial<QueueState>): void {
    this.state = {
      ...this.state,
      ...patch,
      pending: this.queue.length,
      failed: this.queue.filter((r) => this.failedKeys.has(r.key)).length,
    };
    for (const l of this.listeners) l();
  }
}

export const uploadQueue = new UploadQueue();

export function useUploadQueue(): QueueState {
  return useSyncExternalStore(uploadQueue.subscribe, uploadQueue.getState, uploadQueue.getState);
}
