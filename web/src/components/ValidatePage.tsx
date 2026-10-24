import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap, Marker } from 'maplibre-gl';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  VOTE_VALUES,
  localizedName,
  photoUrl,
  reportApi,
  type ReportClassId,
  type ReportItem,
  type VoteResponse,
  type VoteValue,
  type Zone,
} from '../api';
import type { Lang } from '../i18n';
import { refreshUser, useUser } from '../user';
import UserDialog, { UserChip } from './UserDialog';
import { CLASS_GLYPHS } from './ReportSheet';

const RADIUS_M = 300;
const LIMIT = 20;
const GPS_TIMEOUT_MS = 8000;

interface ValidatePageProps {
  zone: Zone | null;
  lang: Lang;
  /** A vote resolved the report: barriers/footpaths/routes changed server-side. */
  onResolved: () => void;
}

type Phase = 'locating' | 'loading' | 'ready' | 'error';
type Source = 'nearby' | 'fallbackNoGps' | 'fallbackNone';
type VoteState = 'idle' | 'voting' | 'voted' | 'ownReport' | 'alreadyResolved' | 'voteError';

const VOTE_GLYPHS: Record<VoteValue, string> = { agree: '✓', disagree: '✗', unsure: '?' };
const VOTE_KEYS: Record<VoteValue, string> = { agree: '1', disagree: '2', unsure: '3' };

function getPosition(): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 30000 },
    );
  });
}

function formatTime(iso: string, lang: Lang): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

// ---------- Mini map: basemap + one marker, not interactive ----------

function MiniMap({ zone, lat, lon, label }: { zone: Zone; lat: number; lon: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || mapRef.current) return;
    const map = new MapLibreMap({
      container: el,
      style: zone.basemap.style_url,
      center: [lon, lat],
      zoom: 17,
      interactive: false,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.getCanvas().setAttribute('aria-hidden', 'true');
    map.getCanvas().tabIndex = -1;
    markerRef.current = new Marker({ color: '#0b5fa5' }).setLngLat([lon, lat]).addTo(map);
    mapRef.current = map;
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.jumpTo({ center: [lon, lat], zoom: 17 });
    markerRef.current?.setLngLat([lon, lat]);
  }, [lat, lon]);

  return <div ref={ref} className="minimap" role="img" aria-label={label} />;
}

// ---------- Page ----------

export default function ValidatePage({ zone, lang, onResolved }: ValidatePageProps) {
  const { t } = useTranslation();
  const user = useUser();
  const [changingUser, setChangingUser] = useState(false);
  const [phase, setPhase] = useState<Phase>('locating');
  const [source, setSource] = useState<Source>('nearby');
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [index, setIndex] = useState(0);
  const [voteState, setVoteState] = useState<VoteState>('idle');
  const [voteResult, setVoteResult] = useState<VoteResponse | null>(null);
  /** Report ids whose photo failed to load (shown as "No photo"). */
  const [brokenPhotos, setBrokenPhotos] = useState<Set<number>>(() => new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keyed on the id only: refreshing the trust score must not reload the list and reset the card.
  const userId = user?.id;
  const load = useCallback(async () => {
    if (userId === undefined) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('locating');
    setIndex(0);
    setVoteState('idle');
    setVoteResult(null);
    const fix = await getPosition();
    if (ac.signal.aborted) return;
    setPhase('loading');
    try {
      let list: ReportItem[] = [];
      let src: Source = 'nearby';
      if (fix) {
        const r = await reportApi.list({ status: 'pending', near: { ...fix, radius_m: RADIUS_M }, user_id: userId, limit: LIMIT }, ac.signal);
        list = r.results;
      }
      if (list.length === 0) {
        const r = await reportApi.list({ status: 'pending', user_id: userId, limit: LIMIT }, ac.signal);
        list = r.results;
        src = fix ? 'fallbackNone' : 'fallbackNoGps';
      }
      if (ac.signal.aborted) return;
      setReports(list);
      setSource(src);
      setPhase('ready');
    } catch (err) {
      if (ac.signal.aborted) return;
      console.warn('[validate]', err);
      setPhase('error');
    }
  }, [userId]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const current: ReportItem | null = phase === 'ready' ? (reports[index] ?? null) : null;

  const vote = useCallback(
    async (value: VoteValue) => {
      if (!user || !current || voteState === 'voting' || voteState === 'voted') return;
      setVoteState('voting');
      try {
        const res = await reportApi.vote(current.id, user.id, value);
        setVoteResult(res);
        setVoteState('voted');
        if (res.resolved) onResolved();
        void refreshUser();
      } catch (err) {
        console.warn('[vote]', err);
        if (err instanceof ApiError && err.status === 409) setVoteState('ownReport');
        else if (err instanceof ApiError && err.status === 400) setVoteState('alreadyResolved');
        else setVoteState('voteError');
      }
      window.setTimeout(() => nextRef.current?.focus(), 0);
    },
    [user, current, voteState, onResolved],
  );

  const next = useCallback(() => {
    setIndex((i) => i + 1);
    setVoteState('idle');
    setVoteResult(null);
    window.setTimeout(() => headingRef.current?.focus(), 0);
  }, []);

  // Keyboard shortcuts 1 / 2 / 3 (not while typing or while a dialog is open).
  const showUserDialog = !user || changingUser;
  useEffect(() => {
    if (showUserDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const value = (Object.keys(VOTE_KEYS) as VoteValue[]).find((v) => VOTE_KEYS[v] === e.key);
      if (!value) return;
      e.preventDefault();
      void vote(value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vote, showUserDialog]);

  const sourceText = source === 'nearby' ? t('validate.nearby') : source === 'fallbackNoGps' ? t('validate.fallbackNoGps') : t('validate.fallbackNone');

  return (
    <div className="page validate">
      <h2 className="capture__title">{t('validate.title')}</h2>
      {user && <UserChip onChange={() => setChangingUser(true)} />}
      <p className="panel__hint">{t('validate.intro')}</p>

      {(phase === 'locating' || phase === 'loading') && (
        <p className="place__status" role="status" aria-live="polite">
          {phase === 'locating' ? t('route.locating') : t('validate.loading')}
        </p>
      )}
      {phase === 'error' && (
        <>
          <p className="place__error" role="alert">
            {t('validate.error')}
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            {t('validate.reload')}
          </button>
        </>
      )}

      {phase === 'ready' && !current && (
        <div className="validate__empty">
          <p className="panel__hint">{sourceText}</p>
          <p className="rcard__none">{t('validate.empty')}</p>
          <button type="button" className="btn" onClick={() => void load()}>
            {t('validate.reload')}
          </button>
        </div>
      )}

      {current && (
        <article className="vcard" aria-labelledby="vcard-title" lang={lang}>
          <p className="panel__hint">
            {sourceText} {t('validate.progress', { index: index + 1, total: reports.length })}
          </p>
          <h3 id="vcard-title" className="vcard__title" ref={headingRef} tabIndex={-1}>
            <span className="tile__glyph" aria-hidden="true">
              {CLASS_GLYPHS[current.class_id as ReportClassId] ?? '❓'}
            </span>
            <span className={`sev sev--${current.severity}`} aria-hidden="true">
              {current.severity}
            </span>{' '}
            {localizedName(current, lang)}
            <span className="badge badge--kind">{current.kind === 'fixed' ? t('validate.kindFixed') : t('validate.kindBarrier')}</span>
          </h3>

          {current.photo_url && !brokenPhotos.has(current.id) ? (
            <img
              className="vcard__photo"
              src={photoUrl(current.photo_url)}
              alt={t('validate.photoAlt', { name: localizedName(current, lang) })}
              decoding="async"
              onError={() => setBrokenPhotos((set) => new Set(set).add(current.id))}
            />
          ) : (
            <p className="vcard__nophoto">{t('validate.noPhoto')}</p>
          )}

          <dl className="vcard__meta">
            <div>
              <dt>{t('popup.class')}</dt>
              <dd>{t(`barrierClass.${current.class_id}`, { defaultValue: String(current.class_id) })}</dd>
            </div>
            <div>
              <dt>{t('severity.label')}</dt>
              <dd>
                {current.severity}: {t(`report.severityWord.${current.severity}`)}
              </dd>
            </div>
            {current.note && (
              <div>
                <dt>{t('validate.note')}</dt>
                <dd>{current.note}</dd>
              </div>
            )}
            {typeof current.distance_m === 'number' && (
              <div>
                <dt>{t('validate.distanceLabel')}</dt>
                <dd>{t('validate.distance', { m: Math.round(current.distance_m) })}</dd>
              </div>
            )}
            <div>
              <dt>{t('images.time')}</dt>
              <dd>{t('validate.reported', { time: formatTime(current.created_at, lang) })}</dd>
            </div>
            <div>
              <dt>{t('popup.status')}</dt>
              <dd>
                {t(`validate.status.${current.status}`, { defaultValue: current.status })} · {t('validate.votesSoFar', { count: current.n_votes })}
                {typeof current.model_prescreen_score === 'number' && ` · ${t('validate.prescreen', { score: current.model_prescreen_score.toFixed(2) })}`}
              </dd>
            </div>
          </dl>
          {current.kind === 'fixed' && current.target_barrier && (
            <p className="panel__hint">
              {t('validate.fixedOf', { name: localizedName(current.target_barrier, lang), severity: current.target_barrier.severity })}
            </p>
          )}

          {zone && <MiniMap zone={zone} lat={current.lat} lon={current.lon} label={t('validate.miniMap')} />}

          {voteState === 'idle' || voteState === 'voting' ? (
            <>
              <p className="field__label vcard__question">{t('validate.question')}</p>
              <div className="votes" role="group" aria-label={t('validate.question')}>
                {VOTE_VALUES.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`btn vote vote--${v}`}
                    onClick={() => void vote(v)}
                    aria-busy={voteState === 'voting'}
                    aria-keyshortcuts={VOTE_KEYS[v]}
                  >
                    <span className="vote__glyph" aria-hidden="true">
                      {VOTE_GLYPHS[v]}
                    </span>
                    <span className="vote__text">{t(`validate.${v}`)}</span>
                    <span className="vote__key" aria-label={t('validate.key', { key: VOTE_KEYS[v] })}>
                      {VOTE_KEYS[v]}
                    </span>
                  </button>
                ))}
              </div>
              <p className="panel__hint">{t('validate.keyHint')}</p>
              <p className="place__status" role="status" aria-live="polite">
                {voteState === 'voting' ? t('validate.voting') : ''}
              </p>
            </>
          ) : (
            <div className="vcard__result">
              {voteState === 'voted' && voteResult ? (
                <p className={`sheet__ok${voteResult.resolved ? ' sheet__ok--strong' : ''}`} role="status" aria-live="assertive">
                  {voteResult.resolved
                    ? voteResult.status === 'rejected'
                      ? t('validate.resolvedRejected')
                      : voteResult.status === 'fixed'
                        ? t('validate.resolvedFixed')
                        : t('validate.resolvedVerified')
                    : t('validate.voted', {
                        score: voteResult.score.toFixed(2),
                        count: voteResult.n_votes,
                        status: t(`validate.status.${voteResult.status}`, { defaultValue: voteResult.status }),
                      })}
                </p>
              ) : (
                <p className="place__error" role="alert">
                  {t(`validate.${voteState}`)}
                </p>
              )}
              <button ref={nextRef} type="button" className="btn btn--primary" onClick={next}>
                {t('validate.next')}
              </button>
            </div>
          )}
        </article>
      )}

      {showUserDialog && (
        <UserDialog lang={lang} onDone={() => setChangingUser(false)} onCancel={user ? () => setChangingUser(false) : undefined} />
      )}
    </div>
  );
}
