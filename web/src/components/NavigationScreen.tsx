// Move mode navigation: black turn banner at the top, the map following the
// traveller behind, a bottom sheet with arrival time / minutes / km and a blue
// progress bar, round floating buttons (voice, report, re-centre, end), the
// clearly labelled simulated walk, and the arrival summary.
import { useEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { CaptureUpload } from '../api';
import { useCamera } from '../camera';
import { formatDistance } from '../geo';
import type { Lang } from '../i18n';
import { SIM_SPEEDS, type NavigationApi } from '../navigation';
import { haversineM, type Sensors } from '../sensors';
import { hrefFor } from '../router';
import { uploadQueue, useUploadQueue } from '../uploadQueue';
import ConfidenceRing from './ConfidenceRing';
import StepGlyph from './StepGlyph';
import { stepInstruction, stepStreet, useAnnouncer, warningName } from './useAnnouncer';

export const CONTRIBUTE_EVERY_M = 10;

interface NavigationScreenProps {
  nav: NavigationApi;
  sensors: Sensors;
  lang: Lang;
  muted: boolean;
  onToggleMute: () => void;
  onReport: () => void;
  onEnd: () => void;
  follow: boolean;
  onRecenter: () => void;
  headingRef: RefObject<HTMLElement>;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `nav-YYYYMMDD` session id for photos contributed while navigating. */
export function navSessionId(now = new Date()): string {
  return `nav-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

/** Hidden camera that contributes a photo every 10 m of real (never simulated) movement. */
function NavContributor({ nav, sensors }: { nav: NavigationApi; sensors: Sensors }) {
  const { t } = useTranslation();
  const camera = useCamera(true);
  const lastRef = useRef<{ lat: number; lon: number } | null>(null);
  const busyRef = useRef(false);
  const pos = nav.state.position;
  const live = camera.state === 'live';
  useEffect(() => {
    if (!live || !pos || pos.simulated || busyRef.current) return;
    const last = lastRef.current;
    if (last && haversineM(last, pos) < CONTRIBUTE_EVERY_M) return;
    busyRef.current = true;
    const fix = sensors.fixRef.current;
    camera
      .grabFrame()
      .then((f) => {
        const o = sensors.orientationRef.current;
        const rec: CaptureUpload = {
          blob: f.blob,
          lat: pos.lat,
          lon: pos.lon,
          gps_accuracy_m: fix ? Math.round(fix.accuracy * 10) / 10 : 50,
          heading_deg: o && o.heading !== null ? Math.round(o.heading * 10) / 10 : null,
          pitch_deg: o && o.pitch !== null ? Math.round(o.pitch * 10) / 10 : null,
          hfov_deg: 65,
          captured_at: new Date().toISOString(),
          session_id: navSessionId(),
          note: '',
          width: f.width,
          height: f.height,
          heading_source: o ? o.source : 'none',
        };
        lastRef.current = { lat: pos.lat, lon: pos.lon };
        return uploadQueue.add(rec);
      })
      .catch((err: unknown) => console.warn('[nav-contribute]', err))
      .finally(() => {
        busyRef.current = false;
      });
  }, [pos, live, camera, sensors]);
  return (
    <div className="navcam" aria-hidden={camera.state !== 'fallback'}>
      <video ref={camera.videoRef} className="navcam__video" playsInline muted autoPlay />
      {camera.state === 'fallback' && <p className="sr-only">{t('contribute.noCamera')}</p>}
    </div>
  );
}

export default function NavigationScreen({ nav, sensors, lang, muted, onToggleMute, onReport, onEnd, follow, onRecenter, headingRef }: NavigationScreenProps) {
  const { t } = useTranslation();
  const { state } = nav;
  const { session, currentStep, distanceToStep, remainingM, progress, etaMs, arrived, simulating, needsSimulation, gps, offRoute } = state;
  const { liveText } = useAnnouncer(nav, lang, muted);
  const queue = useUploadQueue();

  // Focus the banner when navigation starts so screen readers land on the first instruction.
  useEffect(() => {
    const id = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [headingRef]);

  if (!session) return null;
  const dist = formatDistance(distanceToStep);
  const remaining = formatDistance(remainingM);
  const minutesLeft = Math.max(0, Math.round(etaMs / 60000));
  const arrival = new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(new Date(Date.now() + etaMs));
  const street = stepStreet(currentStep, lang);
  const instruction = stepInstruction(currentStep, lang);
  const warnings = currentStep?.warnings ?? [];
  const tripMin = Math.round((Date.now() - session.startedAt) / 60000);

  return (
    <>
      {session.contribute && !simulating && <NavContributor nav={nav} sensors={sensors} />}

      <div className="navtop">
      <div className="turnbanner" role="group" aria-label={t('nav.bannerLabel')} ref={headingRef as RefObject<HTMLDivElement>} tabIndex={-1} onDoubleClick={nav.repeat}>
        <StepGlyph type={arrived ? 'arrive' : (currentStep?.type ?? 'straight')} size={64} className="turnbanner__glyph" />
        <div className="turnbanner__text" lang={lang}>
          <p className="turnbanner__dist">
            {arrived ? t('nav.arrivedShort') : (
              <>
                {dist.value} <span className="turnbanner__unit">{t(`units.${dist.unit}`)}</span>
              </>
            )}
          </p>
          <p className="turnbanner__instr">{arrived ? t('nav.say.arrive') : instruction}</p>
          {street && !arrived && <p className="turnbanner__street">{street}</p>}
        </div>
      </div>
      {warnings.length > 0 && !arrived && (
        <ul className="warnchips" aria-label={t('nav.warningsLabel')}>
          {warnings.map((w, i) => (
            <li key={i} className={`warnchip${w.impassable_for_profile ? ' warnchip--impassable' : ''}`}>
              <span aria-hidden="true">⚠ </span>
              {warningName(w, lang)}
              {w.impassable_for_profile ? ` · ${t('route.impassableFlag')}` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {liveText}
      </p>

      {(simulating || needsSimulation) && (
        <div className={`simbar${simulating ? ' simbar--on' : ''}`} role="status">
          {simulating ? (
            <>
              <span className="simbar__text">
                <span aria-hidden="true">▶ </span>
                {t('nav.simulating', { speed: state.simSpeed })}
              </span>
              <span className="simbar__btns">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => nav.setSimSpeed(SIM_SPEEDS[(SIM_SPEEDS.indexOf(state.simSpeed) + 1) % SIM_SPEEDS.length])}
                  aria-label={t('nav.simSpeed', { speed: state.simSpeed })}
                >
                  ×{state.simSpeed}
                </button>
                <button type="button" className="btn btn--small" onClick={nav.stopSimulation}>
                  {t('nav.simStop')}
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="simbar__text">{offRoute && gps === 'ok' ? t('nav.farFromRoute') : t(`nav.gps.${gps}`)}</span>
              <button type="button" className="btn btn--small btn--primary" onClick={nav.startSimulation}>
                {t('nav.simulate')}
              </button>
            </>
          )}
        </div>
      )}
      </div>

      <div className="fabs" role="group" aria-label={t('nav.controls')}>
        <button type="button" className="rfab" aria-pressed={!muted} aria-label={muted ? t('nav.unmute') : t('nav.mute')} onClick={onToggleMute}>
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
            <path d="M4 9v6h4l5 4V5L8 9z" />
            {muted ? <path d="M17 9l4 6M21 9l-4 6" /> : <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />}
          </svg>
        </button>
        <button type="button" className="rfab" aria-label={t('report.fab')} onClick={onReport}>
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round">
            <path d="M12 3 2 21h20z" />
            <path d="M12 10v5M12 18v.5" />
          </svg>
        </button>
        {!follow && (
          <button type="button" className="rfab" aria-label={t('nav.recenter')} onClick={onRecenter}>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d="M12 3 20 21l-8-4-8 4z" />
            </svg>
          </button>
        )}
        <button type="button" className="rfab rfab--end" aria-label={t('nav.end')} onClick={onEnd}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <section className="navsheet" aria-label={t('nav.sheetLabel')}>
        <div className="grabber" aria-hidden="true" />
        {arrived ? (
          <div className="arrived" role="status">
            <h2 className="arrived__title">{t('nav.arrivedTitle')}</h2>
            <dl className="navsheet__nums">
              <div>
                <dd>{(session.route.length_m / 1000).toFixed(2)}</dd>
                <dt>{t('units.km')}</dt>
              </div>
              <div>
                <dd>{tripMin}</dd>
                <dt>{t('units.min')}</dt>
              </div>
              <div>
                <dd>
                  <ConfidenceRing confidence={session.route.confidence} size={52} showLabel={false} />
                </dd>
                <dt>{t('confidence.title')}</dt>
              </div>
            </dl>
            {session.contribute && (
              <div className="arrived__contrib">
                <p>{t('nav.contributePrompt', { count: queue.captured })}</p>
                <div className="planner__actions">
                  <a className="btn btn--primary" href={hrefFor('capture')} onClick={onEnd}>
                    {t('nav.contributeYes')}
                  </a>
                  <button type="button" className="btn" onClick={onEnd}>
                    {t('nav.contributeNo')}
                  </button>
                </div>
              </div>
            )}
            {!session.contribute && (
              <button type="button" className="btn btn--primary btn--big" onClick={onEnd}>
                {t('report.done')}
              </button>
            )}
          </div>
        ) : (
          <>
            <dl className="navsheet__nums">
              <div>
                <dd className="navsheet__time">{arrival}</dd>
                <dt>{t('nav.arrival')}</dt>
              </div>
              <div>
                <dd>{minutesLeft}</dd>
                <dt>{t('units.min')}</dt>
              </div>
              <div>
                <dd>{remaining.value}</dd>
                <dt>{t(`units.${remaining.unit}`)}</dt>
              </div>
            </dl>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={t('nav.progress')}>
              <span className="progress__bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="navsheet__meta">
              {t('nav.say.start', {
                route: t(`route.mode.${session.mode}.title`),
                label: t(`confidence.${session.route.confidence?.label ?? 'low'}`),
                pct: Math.round(session.route.verified_pct),
              })}
              {session.contribute && (
                <>
                  {' · '}
                  {simulating ? t('nav.contributePaused') : t('nav.contributing', { count: queue.captured })}
                </>
              )}
            </p>
          </>
        )}
      </section>
    </>
  );
}
