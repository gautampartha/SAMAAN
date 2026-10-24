// "Wheels as sensors" (P9): a phone mounted on a wheelchair records the
// accelerometer (devicemotion, ~50-60 Hz) and GPS (~1 Hz) into one sample
// stream. Every 10 s the buffered samples become a batch that is persisted in
// IndexedDB ("rideBatches", key `${rideId}:${seq}`) BEFORE it is posted to
// `POST /rides/{id}/samples`; a batch is deleted once the server accepted it
// and retried with backoff (2 s, 4 s ... 30 s) or when the phone is back
// online. Stop flushes the pending batches, then `POST /rides/{id}/end`
// returns the RideSummary.
//
// The engine is a module-level singleton (like the upload queue) so a ride
// keeps recording while the map page is shown, and React StrictMode's
// double-invoked effects never start or stop anything: only user taps do.
import { useSyncExternalStore } from 'react';
import { ApiError, rideApi, type RideSample, type RideSummary } from './api';
import { getAll, idbAvailable, put, remove, STORE_RIDE_BATCHES } from './idb';
import { getUser } from './user';

export type RidePhase =
  | 'idle'
  /** Asking iOS for motion permission (inside the Start tap). */
  | 'requesting'
  /** Permission granted but no stored user yet: the page shows the "Who are you?" dialog. */
  | 'needUser'
  /** POST /rides in flight; sensors already buffering. */
  | 'starting'
  | 'recording'
  /** Stop pressed: sensors off, sending the remaining batches. */
  | 'flushing'
  /** POST /rides/{id}/end in flight. */
  | 'ending'
  /** POST /rides/replay-demo in flight. */
  | 'demo'
  | 'done';

export type RideError = 'noMotion' | 'denied' | 'noUser' | 'createFailed' | 'rejected' | 'network' | 'endFailed' | 'demoFailed';

export interface RideFix {
  lat: number;
  lon: number;
  accuracy: number;
}

export interface RideState {
  phase: RidePhase;
  error: RideError | null;
  /** HTTP status behind `error` when the API answered. */
  errorStatus: number | null;
  rideId: number | string | null;
  /** Whole seconds since the ride started (frozen when it stops). */
  durationS: number;
  /** Accelerometer samples recorded (GPS fixes are counted separately). */
  samples: number;
  fixes: number;
  batchesSent: number;
  batchesPending: number;
  /** Ground speed from the last GPS fix, m/s; null until known. */
  speedMs: number | null;
  fix: RideFix | null;
  /** RMS (m/s²) of the high-passed vertical axis over the last second; null until a second of data exists. */
  rms: number | null;
  /** Peak |high-passed vertical| (m/s²) over the last second. */
  peak: number | null;
  /** Epoch ms of the last client-side jolt hint (peak above JOLT_THRESHOLD); the server decides for real. */
  lastJoltAt: number | null;
  /** Total client-side jolt hints this ride. */
  joltHints: number;
  online: boolean;
  /** True while a screen wake lock is held. */
  wakeLock: boolean;
  /** Seconds until the next batch retry while backing off. */
  retryInSec: number | null;
  /** What to do once the user dialog closes (phase `needUser`). */
  pendingAction: 'start' | 'demo' | null;
  summary: RideSummary | null;
}

interface Batch {
  key: string;
  rideId: number | string;
  seq: number;
  samples: RideSample[];
  /** Left over from a previous page load; its failures are not shown as errors. */
  restored?: boolean;
}

interface RecentSample {
  t: number;
  ax: number;
  ay: number;
  az: number;
}

/** m/s² of high-passed vertical acceleration above which the page shows "last jolt". */
export const JOLT_THRESHOLD = 6;
export const BATCH_INTERVAL_MS = 10000;
const STATS_INTERVAL_MS = 250;
const WINDOW_S = 1;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30000;
/** If no devicemotion event arrives in this time after Start, the device has no usable sensor. */
const NO_MOTION_TIMEOUT_MS = 4000;

type Listener = () => void;
type RequestPermissionFn = () => Promise<'granted' | 'denied' | 'prompt' | string>;

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

function motionPermissionFn(): RequestPermissionFn | null {
  if (typeof DeviceMotionEvent === 'undefined') return null;
  const fn = (DeviceMotionEvent as unknown as { requestPermission?: RequestPermissionFn }).requestPermission;
  return typeof fn === 'function' ? fn : null;
}

function wakeLockApi(): WakeLockLike | null {
  const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
  return wl && typeof wl.request === 'function' ? wl : null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return ua.length > 120 ? ua.slice(0, 120) : ua;
}

const INITIAL: RideState = {
  phase: 'idle',
  error: null,
  errorStatus: null,
  rideId: null,
  durationS: 0,
  samples: 0,
  fixes: 0,
  batchesSent: 0,
  batchesPending: 0,
  speedMs: null,
  fix: null,
  rms: null,
  peak: null,
  lastJoltAt: null,
  joltHints: 0,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  wakeLock: false,
  retryInSec: null,
  pendingAction: null,
  summary: null,
};

class RideEngine {
  private state: RideState = INITIAL;
  private listeners = new Set<Listener>();
  private started = false;

  // Recording
  private t0 = 0;
  private startedAt: Date | null = null;
  private buffer: RideSample[] = [];
  private recent: RecentSample[] = [];
  private last: RecentSample | null = null;
  private seq = 0;
  private sampleCount = 0;
  private fixCount = 0;
  private motionHandler: ((e: DeviceMotionEvent) => void) | null = null;
  private watchId: number | null = null;
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private noMotionTimer: ReturnType<typeof setTimeout> | null = null;
  private wake: WakeLockSentinelLike | null = null;
  private visibilityHandler: (() => void) | null = null;

  // Sending
  private queue: Batch[] = [];
  private attempts = new Map<string, number>();
  private sending = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private retryAt: number | null = null;
  private abort: AbortController | null = null;

  getState = (): RideState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Attach online/offline listeners and re-send batches left over from a previous page load (once). */
  private start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    void this.restore();
  }

  private async restore(): Promise<void> {
    if (!idbAvailable()) return;
    try {
      const rows = await getAll<Batch>(STORE_RIDE_BATCHES);
      rows.sort((a, b) => a.key.localeCompare(b.key));
      const known = new Set(this.queue.map((b) => b.key));
      for (const r of rows) if (!known.has(r.key)) this.queue.push({ ...r, restored: true });
      this.update({});
      void this.pump();
    } catch (err) {
      console.warn('[ride] could not restore pending batches', err);
    }
  }

  // ---------- Start / stop ----------

  /**
   * Must be called from the Start tap: iOS only grants motion permission inside a user gesture.
   * Checks the sensors, asks for permission, then creates the ride (or asks for a user first).
   */
  async startRide(): Promise<void> {
    const p = this.state.phase;
    if (p !== 'idle' && p !== 'done' && p !== 'needUser') return;
    this.update({ ...INITIAL, online: navigator.onLine, phase: 'requesting' });
    if (typeof DeviceMotionEvent === 'undefined' || window.isSecureContext === false) {
      this.fail('noMotion');
      return;
    }
    const req = motionPermissionFn();
    if (req) {
      let granted = false;
      try {
        granted = (await req.call(DeviceMotionEvent)) === 'granted';
      } catch {
        granted = false;
      }
      if (!granted) {
        this.fail('denied');
        return;
      }
    }
    if (!getUser()) {
      this.update({ phase: 'needUser', pendingAction: 'start' });
      return;
    }
    await this.begin();
  }

  /** The "Who are you?" dialog finished: carry on with what the user wanted. */
  async continueAfterUser(): Promise<void> {
    if (this.state.phase !== 'needUser') return;
    const action = this.state.pendingAction;
    this.update({ pendingAction: null });
    if (!getUser()) {
      this.fail('noUser');
      return;
    }
    if (action === 'demo') await this.replayDemo();
    else await this.begin();
  }

  /** The user dismissed the dialog without creating a user. */
  cancelUser(): void {
    if (this.state.phase === 'needUser') this.update({ phase: 'idle', pendingAction: null });
  }

  private async begin(): Promise<void> {
    const user = getUser();
    if (!user) {
      this.fail('noUser');
      return;
    }
    // Sensors first, so t = 0 is exactly `started_at` and nothing is lost while the request is in flight.
    this.startedAt = new Date();
    this.t0 = performance.now();
    this.buffer = [];
    this.recent = [];
    this.last = null;
    this.seq = 0;
    this.sampleCount = 0;
    this.fixCount = 0;
    this.update({ phase: 'starting', error: null, errorStatus: null, samples: 0, fixes: 0, batchesSent: 0 });
    this.startSensors();
    const ac = new AbortController();
    this.abort = ac;
    try {
      const ride = await rideApi.create({ user_id: user.id, started_at: this.startedAt.toISOString(), device: deviceLabel() }, ac.signal);
      if (ac.signal.aborted) return;
      this.update({ phase: 'recording', rideId: ride.id });
      void this.acquireWakeLock();
      this.batchTimer = setInterval(() => void this.cut(), BATCH_INTERVAL_MS);
      this.statsTimer = setInterval(this.tickStats, STATS_INTERVAL_MS);
      this.noMotionTimer = setTimeout(() => {
        if (this.sampleCount === 0 && this.state.phase === 'recording') {
          this.stopSensors();
          this.clearTimers();
          this.update({ phase: 'idle', error: 'noMotion', rideId: null });
        }
      }, NO_MOTION_TIMEOUT_MS);
    } catch (err) {
      if (ac.signal.aborted) return;
      console.warn('[ride] create failed', err);
      this.stopSensors();
      this.update({ phase: 'idle', error: 'createFailed', errorStatus: err instanceof ApiError ? err.status : null });
    } finally {
      if (this.abort === ac) this.abort = null;
    }
  }

  /** Stop: sensors off, flush the remaining batches, then end the ride on the server. */
  async stopRide(): Promise<void> {
    if (this.state.phase !== 'recording') return;
    this.stopSensors();
    this.clearTimers();
    this.tickStats();
    await this.releaseWakeLock();
    this.update({ phase: 'flushing' });
    await this.cut();
    this.clearRetry();
    await this.pump();
    this.maybeEnd();
  }

  /** Once the queue for this ride is empty, end it (called after every pump while flushing). */
  private maybeEnd(): void {
    if (this.state.phase !== 'flushing') return;
    const id = this.state.rideId;
    if (this.queue.some((b) => b.rideId === id)) return;
    void this.endRide();
  }

  /** Give up on the pending batches of this ride (they can never be accepted once it has ended) and end it. */
  async endAnyway(): Promise<void> {
    if (this.state.phase !== 'flushing') return;
    const id = this.state.rideId;
    this.clearRetry();
    const mine = this.queue.filter((b) => b.rideId === id);
    this.queue = this.queue.filter((b) => b.rideId !== id);
    for (const b of mine) await this.forget(b);
    this.update({});
    await this.endRide();
  }

  /** `endFailed`: try `POST /rides/{id}/end` again. */
  async retryEnd(): Promise<void> {
    if (this.state.phase === 'flushing' || (this.state.phase === 'idle' && this.state.error === 'endFailed' && this.state.rideId !== null)) {
      await this.endRide();
    }
  }

  private async endRide(): Promise<void> {
    const id = this.state.rideId;
    if (id === null) return;
    this.update({ phase: 'ending', error: null, errorStatus: null });
    const ac = new AbortController();
    this.abort = ac;
    try {
      let summary: RideSummary;
      try {
        summary = await rideApi.end(id, new Date().toISOString(), ac.signal);
      } catch (err) {
        // Already ended (a retry after a lost response): the summary is still there.
        if (err instanceof ApiError && err.status === 400) summary = await rideApi.get(id, ac.signal);
        else throw err;
      }
      if (ac.signal.aborted) return;
      this.update({ phase: 'done', summary, rideId: null });
    } catch (err) {
      if (ac.signal.aborted) return;
      console.warn('[ride] end failed', err);
      this.update({ phase: 'idle', error: 'endFailed', errorStatus: err instanceof ApiError ? err.status : null });
    } finally {
      if (this.abort === ac) this.abort = null;
    }
  }

  /** Back to the start screen (keeps nothing of the finished or failed ride). */
  reset(): void {
    const p = this.state.phase;
    if (p === 'recording' || p === 'flushing' || p === 'ending' || p === 'demo' || p === 'starting') return;
    this.abort?.abort();
    this.abort = null;
    this.update({ ...INITIAL, online: navigator.onLine });
  }

  /** `POST /rides/replay-demo`: the server generates and processes a synthetic ride along Riya's route. */
  async replayDemo(): Promise<void> {
    const p = this.state.phase;
    if (p !== 'idle' && p !== 'done' && p !== 'needUser') return;
    const user = getUser();
    if (!user) {
      this.update({ ...INITIAL, online: navigator.onLine, phase: 'needUser', pendingAction: 'demo' });
      return;
    }
    this.update({ ...INITIAL, online: navigator.onLine, phase: 'demo' });
    const ac = new AbortController();
    this.abort = ac;
    try {
      const summary = await rideApi.replayDemo(user.id, ac.signal);
      if (ac.signal.aborted) return;
      this.update({ phase: 'done', summary, durationS: Math.round(summary.duration_s), samples: summary.n_samples });
    } catch (err) {
      if (ac.signal.aborted) return;
      console.warn('[ride] demo failed', err);
      this.update({ phase: 'idle', error: 'demoFailed', errorStatus: err instanceof ApiError ? err.status : null });
    } finally {
      if (this.abort === ac) this.abort = null;
    }
  }

  private fail(error: RideError): void {
    this.update({ phase: 'idle', error, errorStatus: null });
  }

  // ---------- Sensors ----------

  private startSensors(): void {
    this.stopSensors();
    const handler = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.z !== 'number') return;
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return;
      const t = (performance.now() - this.t0) / 1000;
      const s: RecentSample = { t, ax: a.x, ay: a.y, az: a.z };
      this.last = s;
      this.recent.push(s);
      this.buffer.push({ t: round3(t), ax: round3(a.x), ay: round3(a.y), az: round3(a.z) });
      this.sampleCount++;
    };
    this.motionHandler = handler;
    window.addEventListener('devicemotion', handler, { passive: true });

    if ('geolocation' in navigator) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const t = (performance.now() - this.t0) / 1000;
          const c = pos.coords;
          const acc = this.last ?? { ax: 0, ay: 0, az: 0 };
          const sample: RideSample = {
            t: round3(t),
            ax: round3(acc.ax),
            ay: round3(acc.ay),
            az: round3(acc.az),
            lat: c.latitude,
            lon: c.longitude,
            gps_accuracy_m: Math.round(c.accuracy * 10) / 10,
          };
          const speed = typeof c.speed === 'number' && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
          if (speed !== null) sample.speed_m_s = round3(speed);
          this.buffer.push(sample);
          this.fixCount++;
          this.update({ fix: { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy }, speedMs: speed, fixes: this.fixCount });
        },
        (err) => console.warn('[ride] geolocation', err.message),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
      );
    }
  }

  private stopSensors(): void {
    if (this.motionHandler) {
      window.removeEventListener('devicemotion', this.motionHandler);
      this.motionHandler = null;
    }
    if (this.watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  private clearTimers(): void {
    if (this.batchTimer) clearInterval(this.batchTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.noMotionTimer) clearTimeout(this.noMotionTimer);
    this.batchTimer = null;
    this.statsTimer = null;
    this.noMotionTimer = null;
  }

  /**
   * Live hint, computed every 250 ms over the last second: the axis with the largest mean
   * magnitude is the vertical one (it carries gravity); subtracting its 1 s rolling mean
   * high-passes it; the RMS of that is the vibration level and its peak the jolt hint.
   */
  private tickStats = (): void => {
    const now = (performance.now() - this.t0) / 1000;
    const cutoff = now - WINDOW_S;
    let drop = 0;
    while (drop < this.recent.length && this.recent[drop].t < cutoff) drop++;
    if (drop > 0) this.recent.splice(0, drop);
    const n = this.recent.length;
    let rms: number | null = null;
    let peak: number | null = null;
    if (n >= 5) {
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (const s of this.recent) {
        mx += s.ax;
        my += s.ay;
        mz += s.az;
      }
      mx /= n;
      my /= n;
      mz /= n;
      const ax = Math.abs(mx);
      const ay = Math.abs(my);
      const az = Math.abs(mz);
      const axis: keyof RecentSample = ax >= ay && ax >= az ? 'ax' : ay >= az ? 'ay' : 'az';
      const mean = axis === 'ax' ? mx : axis === 'ay' ? my : mz;
      let sum = 0;
      let max = 0;
      for (const s of this.recent) {
        const v = s[axis] - mean;
        sum += v * v;
        if (Math.abs(v) > max) max = Math.abs(v);
      }
      rms = Math.sqrt(sum / n);
      peak = max;
    }
    const patch: Partial<RideState> = { durationS: Math.max(0, Math.floor(now)), samples: this.sampleCount, rms, peak };
    if (peak !== null && peak > JOLT_THRESHOLD) {
      const prev = this.state.lastJoltAt;
      // One hint per second-long event, not one per tick while the window still contains the spike.
      if (prev === null || Date.now() - prev > WINDOW_S * 1000) patch.joltHints = this.state.joltHints + 1;
      patch.lastJoltAt = Date.now();
    }
    this.update(patch);
  };

  // ---------- Wake lock ----------

  private async acquireWakeLock(): Promise<void> {
    const api = wakeLockApi();
    if (!api) return;
    try {
      const sentinel = await api.request('screen');
      this.wake = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.wake === sentinel) this.wake = null;
        this.update({ wakeLock: false });
      });
      this.update({ wakeLock: true });
    } catch (err) {
      console.warn('[ride] wake lock', err);
      this.update({ wakeLock: false });
    }
    if (!this.visibilityHandler) {
      // The lock is released when the tab is hidden; take it again when the user comes back.
      this.visibilityHandler = () => {
        if (document.visibilityState === 'visible' && this.state.phase === 'recording' && !this.wake) void this.acquireWakeLock();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    const w = this.wake;
    this.wake = null;
    if (w && !w.released) {
      try {
        await w.release();
      } catch {
        /* ignore */
      }
    }
    this.update({ wakeLock: false });
  }

  // ---------- Batches ----------

  /** Move the buffered samples into a batch: persist it, then queue it for sending. */
  private async cut(): Promise<void> {
    const id = this.state.rideId;
    if (id === null || this.buffer.length === 0) return;
    const samples = this.buffer;
    this.buffer = [];
    this.seq++;
    const batch: Batch = { key: `${id}:${this.seq}`, rideId: id, seq: this.seq, samples };
    if (idbAvailable()) {
      try {
        await put(STORE_RIDE_BATCHES, batch);
      } catch (err) {
        console.warn('[ride] could not persist batch', err);
      }
    }
    this.queue.push(batch);
    this.update({});
    void this.pump();
  }

  private async forget(b: Batch): Promise<void> {
    this.attempts.delete(b.key);
    if (idbAvailable()) {
      try {
        await remove(STORE_RIDE_BATCHES, b.key);
      } catch (err) {
        console.warn('[ride] could not delete batch', err);
      }
    }
  }

  /** Drop the backoff and try the next batch immediately. */
  retryNow(): void {
    this.clearRetry();
    this.update({ online: navigator.onLine });
    void this.pump().then(() => this.maybeEnd());
  }

  private onOnline = () => {
    this.update({ online: true });
    this.clearRetry();
    void this.pump().then(() => this.maybeEnd());
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
      void this.pump().then(() => this.maybeEnd());
    }, delayMs);
    const tick = () => {
      if (this.retryAt === null) return;
      this.update({ retryInSec: Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000)) });
    };
    tick();
    this.tickTimer = setInterval(tick, 1000);
  }

  /** Send batches one at a time, oldest first; stop on the first retryable failure. */
  private async pump(): Promise<void> {
    if (this.sending || this.retryTimer) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        if (!navigator.onLine) {
          this.update({ online: false });
          break;
        }
        const b = this.queue[0];
        try {
          await rideApi.samples(b.rideId, b.samples);
          this.queue.shift();
          await this.forget(b);
          this.update({ batchesSent: this.state.batchesSent + (b.restored ? 0 : 1), error: this.state.error === 'network' ? null : this.state.error });
        } catch (err) {
          if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
            // Unknown ride or already ended: this batch can never be accepted. Drop it and go on.
            this.queue.shift();
            await this.forget(b);
            if (!b.restored) this.update({ error: 'rejected', errorStatus: err.status });
            continue;
          }
          const n = (this.attempts.get(b.key) ?? 0) + 1;
          this.attempts.set(b.key, n);
          if (!b.restored) this.update({ error: 'network', errorStatus: err instanceof ApiError ? err.status : null });
          this.scheduleRetry(Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS));
          break;
        }
      }
    } finally {
      this.sending = false;
      this.update({});
    }
  }

  private update(patch: Partial<RideState>): void {
    const id = patch.rideId !== undefined ? patch.rideId : this.state.rideId;
    this.state = {
      ...this.state,
      ...patch,
      batchesPending: this.queue.filter((b) => id === null || b.rideId === id).length,
    };
    for (const l of this.listeners) l();
  }
}

export const rideEngine = new RideEngine();

export function useRide(): RideState {
  return useSyncExternalStore(rideEngine.subscribe, rideEngine.getState, rideEngine.getState);
}

/** `m:ss` / `h:mm:ss` for the duration counter. */
export function formatDuration(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 && m < 10 ? `0${m}` : String(m);
  const ss = sec < 10 ? `0${sec}` : String(sec);
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
