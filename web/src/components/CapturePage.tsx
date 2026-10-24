import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { CaptureUpload } from '../api';
import { cardinal, geoQuality, haversineM, useSensors, type GeoFix, type Orientation } from '../sensors';
import { uploadQueue, useUploadQueue, type QueueError } from '../uploadQueue';

// ---------- Settings (localStorage, samaan.capture.*) ----------

const KEY_HFOV = 'samaan.capture.hfov';
const KEY_INTERVAL = 'samaan.capture.interval';
const KEY_SESSION = 'samaan.capture.session';
const KEY_NOTE = 'samaan.capture.note';

const HFOV_DEFAULT = 65;
const HFOV_MIN = 30;
const HFOV_MAX = 120;
const INTERVAL_DEFAULT = 8;
const AUTO_MAX_ACCURACY_M = 25;
const JPEG_QUALITY = 0.85;
const LIVE_REGION_INTERVAL_MS = 2000;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = readStored(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `walk-YYYYMMDD-HHMM` in local time. */
export function defaultSessionId(now = new Date()): string {
  return `walk-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
}

// ---------- Camera helpers ----------

type CameraState = 'starting' | 'live' | 'fallback';

function getUserMediaAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    (typeof window === 'undefined' || window.isSecureContext)
  );
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), 'image/jpeg', JPEG_QUALITY);
  });
}

async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- Component ----------

export default function CapturePage() {
  const { t, i18n } = useTranslation();
  const sensors = useSensors();
  const queue = useUploadQueue();

  // Settings
  const [hfov, setHfov] = useState(() => readNumber(KEY_HFOV, HFOV_DEFAULT, HFOV_MIN, HFOV_MAX));
  const [interval, setIntervalM] = useState(() => readNumber(KEY_INTERVAL, INTERVAL_DEFAULT, 0, 1000));
  const [sessionId, setSessionId] = useState(() => readStored(KEY_SESSION) || defaultSessionId());
  const [note, setNote] = useState(() => readStored(KEY_NOTE) ?? '');
  const [auto, setAuto] = useState(false);

  useEffect(() => writeStored(KEY_HFOV, String(hfov)), [hfov]);
  useEffect(() => writeStored(KEY_INTERVAL, String(interval)), [interval]);
  useEffect(() => writeStored(KEY_SESSION, sessionId), [sessionId]);
  useEffect(() => writeStored(KEY_NOTE, note), [note]);

  // Camera
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<CameraState>(() => (getUserMediaAvailable() ? 'starting' : 'fallback'));
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    if (!getUserMediaAvailable()) return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.muted = true;
          video.srcObject = stream;
          video.play().catch(() => undefined);
        }
        setCamera('live');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCameraError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        setCamera('fallback');
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
  }, []);

  // Capture
  const [flash, setFlash] = useState(false);
  const [captureError, setCaptureError] = useState<'noFix' | 'failed' | null>(null);
  const [lastCaptureAt, setLastCaptureAt] = useState<string | null>(null);
  const capturingRef = useRef(false);
  const lastCaptureFixRef = useRef<{ lat: number; lon: number } | null>(null);
  const settingsRef = useRef({ hfov, sessionId, note });
  settingsRef.current = { hfov, sessionId, note };

  const buildRecord = useCallback(
    (blob: Blob, size: { width: number; height: number }, fix: GeoFix, o: Orientation | null): CaptureUpload => {
      const s = settingsRef.current;
      return {
        blob,
        lat: fix.lat,
        lon: fix.lon,
        gps_accuracy_m: round1(fix.accuracy),
        heading_deg: o && o.heading !== null ? round1(o.heading) : null,
        pitch_deg: o && o.pitch !== null ? round1(o.pitch) : null,
        hfov_deg: s.hfov,
        captured_at: new Date().toISOString(),
        session_id: s.sessionId.trim() || defaultSessionId(),
        note: s.note.trim(),
        width: size.width,
        height: size.height,
        heading_source: o ? o.source : 'none',
      };
    },
    [],
  );

  const enqueue = useCallback(
    async (blob: Blob, size: { width: number; height: number }, fix: GeoFix) => {
      const rec = buildRecord(blob, size, fix, sensors.orientationRef.current);
      lastCaptureFixRef.current = { lat: fix.lat, lon: fix.lon };
      await uploadQueue.add(rec);
      setLastCaptureAt(rec.captured_at);
      setCaptureError(null);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 180);
    },
    [buildRecord, sensors.orientationRef],
  );

  const takePhoto = useCallback(async () => {
    const video = videoRef.current;
    const fix = sensors.fixRef.current;
    if (!video || camera !== 'live' || capturingRef.current) return;
    if (!fix) {
      setCaptureError('noFix');
      return;
    }
    capturingRef.current = true;
    try {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) throw new Error('video has no frame yet');
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');
      ctx.drawImage(video, 0, 0, width, height);
      const blob = await canvasToJpeg(canvas);
      await enqueue(blob, { width, height }, fix);
    } catch (err) {
      console.warn('[capture]', err);
      setCaptureError('failed');
    } finally {
      capturingRef.current = false;
    }
  }, [camera, enqueue, sensors.fixRef]);

  const onFilePicked = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const fix = sensors.fixRef.current;
      if (!fix) {
        setCaptureError('noFix');
        return;
      }
      try {
        const size = await imageSize(file);
        await enqueue(file, size, fix);
      } catch (err) {
        console.warn('[capture]', err);
        setCaptureError('failed');
      }
    },
    [enqueue, sensors.fixRef],
  );

  // Auto capture: moved >= interval metres since the last capture, accuracy <= 25 m.
  const { fix } = sensors;
  useEffect(() => {
    if (!auto || interval <= 0 || !fix || camera !== 'live') return;
    if (fix.accuracy > AUTO_MAX_ACCURACY_M || capturingRef.current) return;
    const last = lastCaptureFixRef.current;
    if (!last || haversineM(last, fix) >= interval) void takePhoto();
  }, [auto, interval, fix, camera, takePhoto]);

  // Screen-reader summary, refreshed at most every 2 s.
  const [liveText, setLiveText] = useState('');
  useEffect(() => {
    const compose = () => {
      const f = sensors.fixRef.current;
      const o = sensors.orientationRef.current;
      const parts: string[] = [];
      if (f) {
        parts.push(
          t('sensors.liveGps', {
            lat: f.lat.toFixed(5),
            lon: f.lon.toFixed(5),
            accuracy: Math.round(f.accuracy),
            quality: t(`sensors.quality.${geoQuality(f.accuracy)}`),
          }),
        );
      } else if (sensors.enabled) {
        parts.push(t('sensors.noFix'));
      }
      if (o && o.heading !== null) {
        parts.push(t('sensors.liveHeading', { heading: Math.round(o.heading), cardinal: t(`sensors.cardinal.${cardinal(o.heading)}`) }));
      }
      if (o && o.pitch !== null) parts.push(t('sensors.livePitch', { pitch: Math.round(o.pitch) }));
      setLiveText(parts.join(' '));
    };
    compose();
    const id = window.setInterval(compose, LIVE_REGION_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [sensors.enabled, sensors.fixRef, sensors.orientationRef, t]);

  const o = sensors.orientation;
  const quality = fix ? geoQuality(fix.accuracy) : null;

  const errorText = useMemo(() => describeError(queue.lastError, t), [queue.lastError, t]);
  const timeFmt = useMemo(() => new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }), [i18n.language]);

  const clampHfov = (e: ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n)) setHfov(Math.min(HFOV_MAX, Math.max(HFOV_MIN, n)));
  };
  const clampInterval = (e: ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n)) setIntervalM(Math.min(1000, Math.max(0, n)));
  };

  const canCapture = camera === 'live' && sensors.enabled;

  return (
    <div className="capture">
      <h2 className="capture__title">{t('capture.title')}</h2>

      {/* ---- Preview ---- */}
      <section className={`capture__preview${flash ? ' capture__preview--flash' : ''}`} aria-label={t('capture.preview')}>
        {camera !== 'fallback' && (
          <video ref={videoRef} className="capture__video" playsInline muted autoPlay aria-label={t('capture.preview')} />
        )}
        {camera === 'starting' && <p className="capture__overlay">{t('capture.cameraStarting')}</p>}
        {camera === 'fallback' && (
          <div className="capture__fallback">
            <p>{t('capture.httpsHint')}</p>
            {cameraError && <p className="capture__raw">{t('capture.cameraError', { message: cameraError })}</p>}
            <label className="btn btn--file">
              <input type="file" accept="image/*" capture="environment" onChange={onFilePicked} />
              {t('capture.filePick')}
            </label>
          </div>
        )}
        {camera === 'live' && o && o.heading !== null && (
          <span
            className="compass compass--overlay"
            aria-hidden="true"
            style={{ transform: `rotate(${o.heading}deg)` }}
          >
            <CompassGlyph />
          </span>
        )}
      </section>

      {/* ---- Live readouts ---- */}
      <section className="readouts" aria-label={t('sensors.title')}>
        <dl className="readouts__list">
          <div className="readouts__row">
            <dt>{t('sensors.position')}</dt>
            <dd>{fix ? `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}` : sensors.enabled ? t('sensors.noFix') : t('sensors.off')}</dd>
          </div>
          <div className="readouts__row">
            <dt>{t('sensors.accuracy')}</dt>
            <dd>
              {fix && quality ? (
                <span className={`quality quality--${quality}`}>
                  ±{Math.round(fix.accuracy)} {t('units.m')} · {t(`sensors.quality.${quality}`)}
                </span>
              ) : (
                '—'
              )}
              {fix && fix.speed !== null && (
                <span className="readouts__extra"> · {t('sensors.speed', { speed: (fix.speed * 3.6).toFixed(1) })}</span>
              )}
            </dd>
          </div>
          <div className="readouts__row">
            <dt>{t('sensors.heading')}</dt>
            <dd>
              {o && o.heading !== null ? (
                <>
                  <span className="compass" aria-hidden="true" style={{ transform: `rotate(${o.heading}deg)` }}>
                    <CompassGlyph />
                  </span>{' '}
                  {Math.round(o.heading)}° {t(`sensors.cardinal.${cardinal(o.heading)}`)}
                </>
              ) : (
                t('sensors.noCompass')
              )}
            </dd>
          </div>
          <div className="readouts__row">
            <dt>{t('sensors.pitch')}</dt>
            <dd>{o && o.pitch !== null ? `${Math.round(o.pitch)}°` : '—'}</dd>
          </div>
          <div className="readouts__row">
            <dt>{t('sensors.sourceLabel')}</dt>
            <dd>{t(`sensors.source.${o ? o.source : 'none'}`)}</dd>
          </div>
        </dl>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveText}
        </p>
        {sensors.geoError && (
          <p className="capture__error" role="alert">
            {t(`sensors.geoError.${sensors.geoError}`)}
          </p>
        )}
        {sensors.permission === 'denied' && (
          <p className="capture__error" role="alert">
            {t('sensors.orientationDenied')}
          </p>
        )}
      </section>

      {/* ---- Settings ---- */}
      <details className="capture__settings">
        <summary className="capture__summary">{t('capture.settings')}</summary>
        <div className="settings">
          <label className="field">
            <span className="field__label">{t('capture.hfov')}</span>
            <input type="number" inputMode="numeric" min={HFOV_MIN} max={HFOV_MAX} step={1} value={hfov} onChange={clampHfov} />
          </label>
          <label className="field">
            <span className="field__label">{t('capture.interval')}</span>
            <input type="number" inputMode="decimal" min={0} max={1000} step={1} value={interval} onChange={clampInterval} />
          </label>
          <label className="field">
            <span className="field__label">{t('capture.sessionId')}</span>
            <span className="field__inline">
              <input type="text" value={sessionId} onChange={(e) => setSessionId(e.target.value)} autoComplete="off" />
              <button type="button" className="btn" onClick={() => setSessionId(defaultSessionId())}>
                {t('capture.newSession')}
              </button>
            </span>
          </label>
          <label className="field">
            <span className="field__label">{t('capture.note')}</span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('capture.notePlaceholder')} />
          </label>
        </div>
      </details>

      {/* ---- Queue ---- */}
      <section className="queue" aria-label={t('queue.title')}>
        <ul className="queue__counters">
          <li>
            <span className="queue__label">{t('queue.captured')}</span> <strong>{queue.captured}</strong>
          </li>
          <li>
            <span className="queue__label">{t('queue.uploaded')}</span> <strong>{queue.uploaded}</strong>
          </li>
          <li>
            <span className="queue__label">{t('queue.pending')}</span> <strong>{queue.pending}</strong>
          </li>
          <li>
            <span className="queue__label">{t('queue.failed')}</span> <strong>{queue.failed}</strong>
          </li>
        </ul>
        <p className="queue__status" role="status" aria-live="polite">
          {!queue.online
            ? t('queue.offline')
            : queue.uploading
              ? t('queue.uploading')
              : queue.retryInSec !== null
                ? t('queue.retryIn', { seconds: queue.retryInSec })
                : lastCaptureAt
                  ? t('capture.captured', { time: timeFmt.format(new Date(lastCaptureAt)) })
                  : t('queue.idle')}
        </p>
        {errorText && (
          <p className="capture__error" role="alert">
            {errorText}
          </p>
        )}
        {captureError && (
          <p className="capture__error" role="alert">
            {t(`capture.${captureError === 'noFix' ? 'noFix' : 'captureFailed'}`)}
          </p>
        )}
      </section>

      {/* ---- Bottom bar: one-handed controls ---- */}
      <div className="capture__bar">
        {!sensors.enabled ? (
          <button
            type="button"
            className="btn btn--primary capture__enable"
            onClick={() => void sensors.enable()}
            disabled={sensors.permission === 'requesting'}
          >
            {t('capture.enableSensors')}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            aria-pressed={auto}
            onClick={() => setAuto((v) => !v)}
            disabled={camera !== 'live' || interval <= 0}
          >
            {t('capture.auto')}
          </button>
        )}
        <button type="button" className="btn btn--primary capture__shutter" onClick={() => void takePhoto()} disabled={!canCapture}>
          {t('capture.takePhoto')}
        </button>
        <button type="button" className="btn" onClick={() => uploadQueue.retryNow()} disabled={queue.pending === 0}>
          {t('queue.retry')}
        </button>
      </div>
    </div>
  );
}

function CompassGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" focusable="false" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3 L16 13 L12 11 L8 13 Z" fill="currentColor" />
    </svg>
  );
}

function describeError(err: QueueError, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  if (!err) return null;
  const detail = err.kind === 'http' ? t('queue.errorHttp', { status: err.status }) : t('queue.errorNetwork', { message: err.message });
  return t('queue.lastError', { detail });
}
