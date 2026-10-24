import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  BARRIER_CLASS_IDS,
  REPORT_ONLY_CLASS_IDS,
  SEVERITIES,
  localizedName,
  reportApi,
  type ReportClassId,
  type ReportItem,
  type ReportPrefill,
  type ReportTarget,
  type Severity,
} from '../api';
import { imageSize, useCamera } from '../camera';
import type { Lang } from '../i18n';
import { geoQuality, useSensors, type GeoFix, type Orientation } from '../sensors';
import { refreshUser, useUser } from '../user';
import UserDialog, { UserChip, trapTab } from './UserDialog';

/** `prefill` (P9, "Photograph this" on a jolt): class and barrier position come from the suspected barrier. */
export type ReportMode = { kind: 'barrier'; prefill?: ReportPrefill } | { kind: 'fixed'; target: ReportTarget };

const ALL_CLASS_IDS: readonly string[] = [...BARRIER_CLASS_IDS, ...REPORT_ONLY_CLASS_IDS];

function knownClass(id: string | undefined): ReportClassId | null {
  return id && ALL_CLASS_IDS.includes(id) ? (id as ReportClassId) : null;
}

interface ReportSheetProps {
  mode: ReportMode;
  lang: Lang;
  onClose: () => void;
  /** A report was accepted by the API (status pending). */
  onSubmitted: (report: ReportItem) => void;
}

export const CLASS_GLYPHS: Record<ReportClassId, string> = {
  steps_or_high_kerb: '🪜',
  parked_vehicle: '🚗',
  open_drain: '🕳️',
  curb_ramp: '♿',
  broken_surface: '🧱',
  fixed_obstacle: '🚧',
  vendor_encroachment: '🛒',
  bike_barrier: '🚲',
  no_footpath: '🚫',
  footpath_end: '⛔',
  waterlogging: '🌊',
  construction: '🏗️',
  lift_out_of_service: '🛗',
  foot_overbridge_stairs_only: '🌉',
};

type SubmitState = 'idle' | 'sending' | 'done';
type ErrorKind = 'noUser' | 'noClass' | 'noSeverity' | 'noPhoto' | 'noGps' | 'rateLimit' | 'gpsOffset' | 'notFound' | 'invalid' | 'generic';

interface Photo {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  /** GPS fix and orientation at capture time (null when none yet). */
  fix: GeoFix | null;
  orientation: Orientation | null;
  capturedAt: string;
}

function readHfov(): number {
  try {
    const n = Number(localStorage.getItem('samaan.capture.hfov'));
    if (Number.isFinite(n) && n >= 30 && n <= 120) return n;
  } catch {
    /* ignore */
  }
  return 65;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function classifyError(err: unknown): ErrorKind {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'rateLimit';
    if (err.status === 422) return err.detail === 'gps_offset' ? 'gpsOffset' : 'invalid';
    if (err.status === 404) return 'notFound';
  }
  return 'generic';
}

/** Five bars with `level` of them filled: a pictogram for the severity word. */
export function SeverityGlyph({ level }: { level: Severity }) {
  return (
    <svg viewBox="0 0 40 24" width="40" height="24" aria-hidden="true" focusable="false" className="sevglyph">
      {SEVERITIES.map((n) => (
        <rect
          key={n}
          x={(n - 1) * 8}
          y={24 - 4 * n - 4}
          width="6"
          height={4 * n + 4}
          rx="1"
          fill={n <= level ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.2"
        />
      ))}
    </svg>
  );
}

export default function ReportSheet({ mode, lang, onClose, onSubmitted }: ReportSheetProps) {
  const { t } = useTranslation();
  const id = useId();
  const user = useUser();
  const [changingUser, setChangingUser] = useState(false);
  const fixed = mode.kind === 'fixed';
  const target = mode.kind === 'fixed' ? mode.target : null;
  const prefill = mode.kind === 'barrier' ? (mode.prefill ?? null) : null;

  // GPS + compass: start immediately (iOS needs a gesture for the compass; that only drops the heading).
  const sensors = useSensors();
  const { enable } = sensors;
  useEffect(() => {
    void enable();
  }, [enable]);

  const showUserDialog = !user || changingUser;
  const [photo, setPhoto] = useState<Photo | null>(null);
  // Camera runs only while a photo is still to be taken and the sheet is in the foreground.
  const camera = useCamera(!photo && !showUserDialog);
  const [photoError, setPhotoError] = useState(false);
  const [classId, setClassId] = useState<ReportClassId | null>(target ? (target.class_id as ReportClassId) : knownClass(prefill?.class_id));
  const [severity, setSeverity] = useState<Severity | null>(target ? target.severity : null);
  const [note, setNote] = useState('');
  const [state, setState] = useState<SubmitState>('idle');
  const [error, setError] = useState<ErrorKind | null>(null);
  const [result, setResult] = useState<ReportItem | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Focus the heading when the sheet (re)gains the foreground.
  useEffect(() => {
    if (showUserDialog) return;
    const h = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(h);
  }, [showUserDialog]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url);
  }, [photo]);

  const setPhotoFrom = useCallback(
    (blob: Blob, size: { width: number; height: number }) => {
      setPhoto({
        blob,
        url: URL.createObjectURL(blob),
        width: size.width,
        height: size.height,
        fix: sensors.fixRef.current,
        orientation: sensors.orientationRef.current,
        capturedAt: new Date().toISOString(),
      });
      setPhotoError(false);
      setError((e) => (e === 'noPhoto' ? null : e));
    },
    [sensors.fixRef, sensors.orientationRef],
  );

  const takePhoto = async () => {
    try {
      const f = await camera.grabFrame();
      setPhotoFrom(f.blob, f);
    } catch (err) {
      console.warn('[report]', err);
      setPhotoError(true);
    }
  };

  const onFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setPhotoFrom(file, await imageSize(file));
    } catch (err) {
      console.warn('[report]', err);
      setPhotoError(true);
    }
  };

  const retake = () => setPhoto(null);

  const submit = async () => {
    if (state === 'sending') return;
    if (!user) return setError('noUser');
    if (!classId) return setError('noClass');
    if (!severity) return setError('noSeverity');
    if (fixed && !photo) return setError('noPhoto');
    const device = sensors.fixRef.current;
    // A prefilled jolt is the barrier position; the photo/device fix is where the reporter stands.
    const at = prefill ? { lat: prefill.lat, lon: prefill.lon } : (photo?.fix ?? device);
    if (!at) return setError('noGps');
    const o = photo?.orientation ?? sensors.orientationRef.current;
    setState('sending');
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const rep = await reportApi.create(
        {
          photo: photo?.blob ?? null,
          user_id: user.id,
          class_id: classId,
          severity,
          note,
          lat: at.lat,
          lon: at.lon,
          heading_deg: o && o.heading !== null ? round1(o.heading) : null,
          pitch_deg: o && o.pitch !== null ? round1(o.pitch) : null,
          hfov_deg: photo ? readHfov() : null,
          captured_at: photo?.capturedAt ?? new Date().toISOString(),
          device_lat: (device ?? at).lat,
          device_lon: (device ?? at).lon,
          kind: fixed ? 'fixed' : 'barrier',
          target_barrier_id: target?.id,
        },
        ac.signal,
      );
      if (ac.signal.aborted) return;
      setResult(rep);
      setState('done');
      onSubmitted(rep);
      void refreshUser();
    } catch (err) {
      if (ac.signal.aborted) return;
      console.warn('[report]', err);
      setError(classifyError(err));
      setState('idle');
    }
  };

  const reset = () => {
    setPhoto(null);
    setNote('');
    if (!fixed) {
      setClassId(null);
      setSeverity(null);
    }
    setResult(null);
    setError(null);
    setState('idle');
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    trapTab(e);
  };

  const fix = sensors.fix;
  const title = fixed ? t('report.titleFixed') : t('report.title');
  const prescreen = result && typeof result.model_prescreen_score === 'number' ? result.model_prescreen_score : null;

  return (
    <>
      <div className="modal" role="presentation">
        <section
          className="modal__card sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${id}-title`}
          onKeyDown={onKeyDown}
          aria-hidden={showUserDialog || undefined}
        >
          <div className="panel__head">
            <h2 id={`${id}-title`} className="panel__title" ref={headingRef} tabIndex={-1}>
              {title}
            </h2>
            <button type="button" className="btn btn--icon" onClick={onClose} aria-label={t('panels.close')}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <UserChip onChange={() => setChangingUser(true)} />
          <p className="panel__hint">{fixed ? t('report.introFixed') : t('report.intro')}</p>

          {prefill && (
            <p className="sheet__target" lang={lang}>
              <span className="field__label">{t('report.prefillTitle')}: </span>
              {prefill.name_en ? localizedName({ name_en: prefill.name_en, name_hi: prefill.name_hi ?? null }, lang) : null}
              {prefill.name_en ? ' · ' : null}
              {t('report.prefilled', { lat: prefill.lat.toFixed(5), lon: prefill.lon.toFixed(5) })}
            </p>
          )}

          {target && (
            <p className="sheet__target" lang={lang}>
              <span className="field__label">{t('report.target')}: </span>
              <span className={`sev sev--${target.severity}`} aria-hidden="true">
                {target.severity}
              </span>{' '}
              {localizedName(target, lang)} · {t(`barrierClass.${target.class_id}`, { defaultValue: String(target.class_id) })} ·{' '}
              {t('severity.label')} {target.severity}: {t(`report.severityWord.${target.severity}`)}
            </p>
          )}

          {state === 'done' && result ? (
            <div className="sheet__done" role="status" aria-live="polite">
              <p className="sheet__ok">
                <span aria-hidden="true">✓ </span>
                {fixed ? t('report.sentFixed') : t('report.sent')}
              </p>
              {!fixed && (
                <p className="panel__hint">
                  {prescreen !== null
                    ? t('report.prescreen', { name: localizedName(result, lang), score: prescreen.toFixed(2) })
                    : t('report.prescreenNone')}
                </p>
              )}
              {typeof result.duplicate_of_barrier_id === 'number' && (
                <p className="panel__hint">{t('report.duplicate', { id: result.duplicate_of_barrier_id })}</p>
              )}
              <div className="planner__actions">
                <button type="button" className="btn btn--primary" onClick={onClose}>
                  {t('report.done')}
                </button>
                {!fixed && (
                  <button type="button" className="btn" onClick={reset}>
                    {t('report.another')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* ---- Position ---- */}
              <p className="sheet__gps" role="status" aria-live="polite">
                <span className="field__label">{t('report.gps')}: </span>
                {fix ? (
                  <span className={`quality quality--${geoQuality(fix.accuracy)}`}>
                    {t('report.gpsFix', {
                      lat: fix.lat.toFixed(5),
                      lon: fix.lon.toFixed(5),
                      accuracy: Math.round(fix.accuracy),
                      quality: t(`sensors.quality.${geoQuality(fix.accuracy)}`),
                    })}
                  </span>
                ) : sensors.geoError ? (
                  <span className="sheet__warn">{t('report.gpsNone')}</span>
                ) : (
                  t('report.gpsWaiting')
                )}
              </p>

              {/* ---- Photo ---- */}
              <section className="sheet__photo" aria-labelledby={`${id}-photo`}>
                <h3 id={`${id}-photo`} className="field__label">
                  {t('report.photo')} <span className="panel__count">({fixed ? t('report.photoRequired') : t('report.photoOptional')})</span>
                </h3>
                <div className="capture__preview sheet__preview">
                  {photo ? (
                    <img className="sheet__img" src={photo.url} alt={t('report.photoAlt')} width={photo.width} height={photo.height} />
                  ) : (
                    <>
                      {camera.state !== 'fallback' && (
                        <video ref={camera.videoRef} className="capture__video" playsInline muted autoPlay aria-label={t('capture.preview')} />
                      )}
                      {camera.state === 'starting' && <p className="capture__overlay">{t('capture.cameraStarting')}</p>}
                      {camera.state === 'fallback' && (
                        <div className="capture__fallback">
                          <p>{t('report.noCamera')}</p>
                          {camera.error && <p className="capture__raw">{t('capture.cameraError', { message: camera.error })}</p>}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="planner__actions">
                  {photo ? (
                    <button type="button" className="btn" onClick={retake}>
                      {t('report.retake')}
                    </button>
                  ) : camera.state === 'live' ? (
                    <button type="button" className="btn btn--primary" onClick={() => void takePhoto()}>
                      {t('report.takePhoto')}
                    </button>
                  ) : null}
                  {!photo && (
                    <label className="btn btn--file">
                      <input type="file" accept="image/*" capture="environment" onChange={(e) => void onFilePicked(e)} />
                      {t('capture.filePick')}
                    </label>
                  )}
                </div>
                <p className="sr-only" role="status" aria-live="polite">
                  {photo ? t('report.photoTaken') : ''}
                </p>
                {photoError && (
                  <p className="place__error" role="alert">
                    {t('capture.captureFailed')}
                  </p>
                )}
              </section>

              {/* ---- Class ---- */}
              {!fixed && (
                <fieldset className="tiles-group">
                  <legend className="field__label">{t('report.class')}</legend>
                  <p className="panel__hint tiles__sub">{t('report.classDetector')}</p>
                  <div className="tiles">
                    {BARRIER_CLASS_IDS.map((c) => (
                      <ClassTile key={c} name={`${id}-class`} value={c} checked={classId === c} onChange={() => setClassId(c)} />
                    ))}
                  </div>
                  <p className="panel__hint tiles__sub">{t('report.classOther')}</p>
                  <div className="tiles">
                    {REPORT_ONLY_CLASS_IDS.map((c) => (
                      <ClassTile key={c} name={`${id}-class`} value={c} checked={classId === c} onChange={() => setClassId(c)} />
                    ))}
                  </div>
                </fieldset>
              )}

              {/* ---- Severity ---- */}
              {!fixed && (
                <fieldset className="tiles-group">
                  <legend className="field__label">{t('report.severity')}</legend>
                  <div className="tiles tiles--sev">
                    {SEVERITIES.map((s) => (
                      <label key={s} className="tile tile--sev">
                        <input type="radio" name={`${id}-sev`} value={s} checked={severity === s} onChange={() => setSeverity(s)} />
                        <span className="tile__glyph" aria-hidden="true">
                          <SeverityGlyph level={s} />
                        </span>
                        <span className="tile__num" aria-hidden="true">
                          {s}
                        </span>
                        <span className="tile__text">
                          <span className="sr-only">{s}: </span>
                          {t(`report.severityWord.${s}`)}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {/* ---- Note ---- */}
              <label className="field">
                <span className="field__label">{t('report.note')}</span>
                <input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t('report.notePlaceholder')} />
              </label>

              {error && (
                <p className="place__error" role="alert">
                  {t(`report.errors.${error === 'noSeverity' ? 'noClass' : error}`)}
                </p>
              )}
              <p className="place__status" role="status" aria-live="polite">
                {state === 'sending' ? t('report.sending') : ''}
              </p>
              <div className="sheet__actions">
                <button type="button" className="btn btn--primary sheet__submit" onClick={() => void submit()} aria-busy={state === 'sending'}>
                  {t('report.submit')}
                </button>
                <button type="button" className="btn" onClick={onClose}>
                  {t('panels.close')}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {showUserDialog && (
        <UserDialog
          lang={lang}
          onDone={() => setChangingUser(false)}
          onCancel={user ? () => setChangingUser(false) : onClose}
        />
      )}
    </>
  );
}

function ClassTile({ name, value, checked, onChange }: { name: string; value: ReportClassId; checked: boolean; onChange: () => void }) {
  const { t } = useTranslation();
  return (
    <label className="tile">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} />
      <span className="tile__glyph" aria-hidden="true">
        {CLASS_GLYPHS[value]}
      </span>
      <span className="tile__text">{t(`barrierClass.${value}`)}</span>
    </label>
  );
}
