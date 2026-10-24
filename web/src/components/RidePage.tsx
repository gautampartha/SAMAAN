import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RideSummary } from '../api';
import type { Lang } from '../i18n';
import { formatDuration, rideEngine, useRide, type RideError } from '../ride';
import { useUser } from '../user';
import UserDialog, { UserChip } from './UserDialog';

interface RidePageProps {
  lang: Lang;
  /** "Show on map": turn the Wheels layer on and fit the verified edges. */
  onShowOnMap: (summary: RideSummary) => void;
}

const LIVE_REGION_INTERVAL_MS = 5000;
const ROUGHNESS_ROWS = 8;

function errorText(error: RideError, status: number | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (error === 'rejected') return t('ride.errors.rejected', { status: status ?? '—' });
  return t(`ride.errors.${error}`);
}

export default function RidePage({ lang, onShowOnMap }: RidePageProps) {
  const { t, i18n } = useTranslation();
  const ride = useRide();
  const user = useUser();
  const [changingUser, setChangingUser] = useState(false);
  const summaryHeadingRef = useRef<HTMLHeadingElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);

  const { phase } = ride;
  const active = phase === 'starting' || phase === 'recording' || phase === 'flushing' || phase === 'ending';
  const busy = active || phase === 'requesting' || phase === 'demo';
  const showUserDialog = phase === 'needUser' || changingUser;

  // The summary heading takes focus when a ride (or the demo) finishes, so the keyboard flow continues there.
  useEffect(() => {
    if (phase !== 'done') return;
    const id = window.setTimeout(() => summaryHeadingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [phase]);

  // Screen-reader summary while recording, at most every 5 s (the counters change 4 times a second).
  const [liveText, setLiveText] = useState('');
  useEffect(() => {
    if (phase !== 'recording') {
      setLiveText('');
      return;
    }
    const compose = () => {
      const s = rideEngine.getState();
      const parts = [
        t('ride.live', { duration: formatDuration(s.durationS), samples: s.samples, sent: s.batchesSent, pending: s.batchesPending }),
      ];
      if (s.lastJoltAt !== null && Date.now() - s.lastJoltAt < LIVE_REGION_INTERVAL_MS) parts.push(t('ride.liveJolt'));
      setLiveText(parts.join(' '));
    };
    compose();
    const id = window.setInterval(compose, LIVE_REGION_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [phase, t]);

  const nf1 = useMemo(() => new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [i18n.language]);
  const nf2 = useMemo(() => new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), [i18n.language]);
  const nf0 = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);

  const statusText = (() => {
    switch (phase) {
      case 'requesting':
        return t('ride.requesting');
      case 'starting':
        return t('ride.starting');
      case 'recording':
        if (!ride.online) return t('ride.offline');
        if (ride.retryInSec !== null) return t('ride.retryIn', { seconds: ride.retryInSec });
        return ride.wakeLock ? t('ride.recording') : t('ride.recordingNoWakeLock');
      case 'flushing':
        if (!ride.online) return t('ride.offline');
        if (ride.retryInSec !== null) return t('ride.retryIn', { seconds: ride.retryInSec });
        return t('ride.flushing', { pending: ride.batchesPending });
      case 'ending':
        return t('ride.ending');
      case 'demo':
        return t('ride.demoRunning');
      default:
        return '';
    }
  })();

  const joltAgo = ride.lastJoltAt === null ? null : Math.max(0, Math.round((Date.now() - ride.lastJoltAt) / 1000));
  const summary = ride.summary;
  const roughness = useMemo(
    () => (summary ? [...summary.roughness].sort((a, b) => b.roughness_index - a.roughness_index).slice(0, ROUGHNESS_ROWS) : []),
    [summary],
  );

  return (
    <div className="page ride" aria-hidden={showUserDialog || undefined}>
      <h2 className="capture__title">{t('ride.title')}</h2>
      <p className="panel__hint">{t('ride.intro')}</p>
      <p className="panel__hint">{t('ride.httpsHint')}</p>
      {user && <UserChip onChange={() => setChangingUser(true)} />}

      {ride.error && (
        <p className="capture__error" role="alert">
          {errorText(ride.error, ride.errorStatus, t)}
          {ride.error === 'endFailed' && ride.rideId !== null && (
            <button type="button" className="btn btn--small ride__inline" onClick={() => void rideEngine.retryEnd()}>
              {t('ride.retryEnd')}
            </button>
          )}
        </p>
      )}

      <p className="place__status ride__status" role="status" aria-live="polite">
        {statusText}
      </p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveText}
      </p>

      {/* ---- Live counters while a ride is running ---- */}
      {active && (
        <section className="ride__live" aria-label={t('ride.liveTitle')}>
          <dl className="ride__counters">
            <div>
              <dt>{t('ride.duration')}</dt>
              <dd>{formatDuration(ride.durationS)}</dd>
            </div>
            <div>
              <dt>{t('ride.samples')}</dt>
              <dd>{nf0.format(ride.samples)}</dd>
            </div>
            <div>
              <dt>{t('ride.batches')}</dt>
              <dd className="ride__small">{t('ride.batchesValue', { sent: ride.batchesSent, pending: ride.batchesPending })}</dd>
            </div>
            <div>
              <dt>{t('ride.speed')}</dt>
              <dd>{ride.speedMs === null ? t('ride.waiting') : t('ride.speedValue', { v: nf1.format(ride.speedMs * 3.6) })}</dd>
            </div>
            <div>
              <dt>{t('ride.rms')}</dt>
              <dd>{ride.rms === null ? t('ride.waiting') : t('ride.rmsValue', { v: nf2.format(ride.rms) })}</dd>
            </div>
            <div className={joltAgo !== null && joltAgo < 3 ? 'ride__jolt ride__jolt--fresh' : 'ride__jolt'}>
              <dt>{t('ride.lastJolt')}</dt>
              <dd>
                {joltAgo === null ? (
                  t('ride.noJolt')
                ) : (
                  <>
                    <span aria-hidden="true">! </span>
                    {t('ride.lastJoltValue', { s: joltAgo })}
                  </>
                )}
              </dd>
            </div>
          </dl>
          <p className="ride__meta">
            {ride.fix
              ? t('ride.gpsFix', { lat: ride.fix.lat.toFixed(5), lon: ride.fix.lon.toFixed(5), accuracy: Math.round(ride.fix.accuracy) })
              : t('ride.gpsWaiting')}
            {' · '}
            {ride.wakeLock ? t('ride.wake.on') : t('ride.wake.off')}
            {' · '}
            {t('ride.joltHints', { count: ride.joltHints })}
          </p>
          <p className="panel__hint">{t('ride.hintOnly')}</p>
        </section>
      )}

      {/* ---- Summary ---- */}
      {phase === 'done' && summary && (
        <section className="ride__summary" aria-labelledby="ride-summary-title">
          <h3 id="ride-summary-title" className="ride__summaryTitle" ref={summaryHeadingRef} tabIndex={-1}>
            {t('ride.summaryTitle')}
            {summary.synthetic && <span className="badge badge--synthetic">{t('badge.synthetic')}</span>}
          </h3>
          <p className="sheet__ok sheet__ok--strong" role="status">
            <span aria-hidden="true">✓ </span>
            {t('ride.verifiedEdges', { count: summary.edges_verified_by_wheels })} · {t('ride.joltsFound', { count: summary.jolts })}
          </p>
          <dl className="ride__counters">
            <div>
              <dt>{t('ride.duration')}</dt>
              <dd>{formatDuration(summary.duration_s)}</dd>
            </div>
            <div>
              <dt>{t('ride.samples')}</dt>
              <dd>{nf0.format(summary.n_samples)}</dd>
            </div>
            <div>
              <dt>{t('ride.windows')}</dt>
              <dd className="ride__small">{t('ride.windowsValue', { matched: nf0.format(summary.n_matched_windows), total: nf0.format(summary.n_windows) })}</dd>
            </div>
            <div>
              <dt>{t('ride.edgesTraversed')}</dt>
              <dd>{nf0.format(summary.edges_traversed)}</dd>
            </div>
          </dl>
          {roughness.length > 0 && (
            <details className="capture__settings">
              <summary className="capture__summary">{t('ride.roughnessTitle')}</summary>
              <ul className="ride__rough">
                {roughness.map((r) => (
                  <li key={r.edge_id}>{t('ride.roughnessRow', { edge: r.edge_id, v: nf2.format(r.roughness_index), windows: r.n_windows })}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="planner__actions">
            <button type="button" className="btn btn--primary ride__big" onClick={() => onShowOnMap(summary)}>
              {t('ride.showOnMap')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                rideEngine.reset();
                window.setTimeout(() => startRef.current?.focus(), 0);
              }}
            >
              {t('ride.newRide')}
            </button>
          </div>
        </section>
      )}

      {/* ---- Controls ---- */}
      <div className="ride__bar">
        {phase === 'recording' ? (
          <button type="button" className="btn ride__start ride__stop" onClick={() => void rideEngine.stopRide()}>
            <span aria-hidden="true">■ </span>
            {t('ride.stop')}
          </button>
        ) : phase === 'flushing' ? (
          <>
            <button type="button" className="btn" onClick={() => rideEngine.retryNow()} disabled={ride.batchesPending === 0}>
              {t('ride.retryNow')}
            </button>
            <button type="button" className="btn" onClick={() => void rideEngine.endAnyway()}>
              {t('ride.endAnyway')}
            </button>
          </>
        ) : (
          phase !== 'done' && (
            <button
              ref={startRef}
              type="button"
              className="btn btn--primary ride__start"
              onClick={() => void rideEngine.startRide()}
              disabled={busy}
              aria-busy={busy}
            >
              <span aria-hidden="true">● </span>
              {t('ride.start')}
            </button>
          )
        )}
      </div>

      {!active && phase !== 'done' && (
        <section className="ride__demo" aria-labelledby="ride-demo-title">
          <h3 id="ride-demo-title" className="panel__subtitle">
            {t('ride.demoTitle')} <span className="badge badge--synthetic">{t('badge.synthetic')}</span>
          </h3>
          <p className="panel__hint">{t('ride.demoHint')}</p>
          <button type="button" className="btn ride__demoBtn" onClick={() => void rideEngine.replayDemo()} disabled={busy} aria-busy={phase === 'demo'}>
            <span aria-hidden="true">▶ </span>
            {t('ride.demo')}
          </button>
        </section>
      )}

      {showUserDialog && (
        <UserDialog
          lang={lang}
          onDone={() => {
            setChangingUser(false);
            if (phase === 'needUser') void rideEngine.continueAfterUser();
          }}
          onCancel={() => {
            setChangingUser(false);
            rideEngine.cancelUser();
          }}
        />
      )}
    </div>
  );
}
