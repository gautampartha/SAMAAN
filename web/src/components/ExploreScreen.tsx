// Explore mode (dyslexic / autistic travellers): an AR-style HUD in the spirit of
// the team's earlier "Smart Sanskriti" explore screen. A dark top card (destination,
// distance + bearing pill, trip progress) above the live camera; over the camera a
// four-way view switcher (Camera / Map / Arrow only / Steps), a status pill (live or
// simulated), a glowing compass disc whose needle turns to (bearing to the next step
// minus the device heading) with a continuous rotation so it never spins the long
// way round, a caption ("Turn 23° right · 120 m"), a faint "ground ahead" ring and a
// "SAMAAN says" card with the spoken instruction. Same step engine as Navigate.
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useCamera } from '../camera';
import { angleDiff, bearing, bearingAlong, formatDistance } from '../geo';
import type { Lang } from '../i18n';
import { SIM_SPEEDS, type NavigationApi } from '../navigation';
import type { Sensors } from '../sensors';
import StepGlyph, { stepTypeOf } from './StepGlyph';
import { stepInstruction, stepStreet, useAnnouncer, warningName } from './useAnnouncer';

interface ExploreScreenProps {
  nav: NavigationApi;
  sensors: Sensors;
  lang: Lang;
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  onReport: () => void;
  headingRef: RefObject<HTMLElement>;
  /** Destination label from the planner; falls back to the arrival street, then "Destination". */
  destination?: string | null;
}

export type ExploreView = 'camera' | 'map' | 'arrow' | 'steps';
const VIEWS: readonly ExploreView[] = ['camera', 'map', 'arrow', 'steps'] as const;
const VIEW_KEY = 'samaan.explore.view';
/** Pre-HUD preference: "Simplify" on means start in the arrow-only view. */
const LEGACY_SIMPLIFY_KEY = 'samaan.explore.simplify';
/** Within this many degrees of the heading the caption says "continue straight". */
export const STRAIGHT_DEG = 8;
/** Needle path (24x30 arrowhead) from the Smart Sanskriti HUD. */
const NEEDLE_PATH = 'M16 2 27 28 16 23 5 28 16 2Z';
const COORDS_RE = /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/;

function readView(): ExploreView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v && (VIEWS as readonly string[]).includes(v)) return v as ExploreView;
    if (localStorage.getItem(LEGACY_SIMPLIFY_KEY) === '1') return 'arrow';
  } catch {
    /* ignore */
  }
  return 'camera';
}

/** Continuous needle angle: adds the shortest signed delta to the previous angle so the needle never spins the long way. */
export function continuousAngle(previous: number, target: number): number {
  return previous + angleDiff(target, previous);
}

function Icon({ name }: { name: 'back' | 'speaker' | 'speakerOff' | 'camera' | 'map' | 'arrow' | 'list' | 'play' | 'pause' | 'flag' | 'dot' | 'warn' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: 'false' as const };
  switch (name) {
    case 'back':
      return (
        <svg {...common} width={22} height={22}>
          <path d="M15 5l-7 7 7 7" />
        </svg>
      );
    case 'speaker':
      return (
        <svg {...common} width={22} height={22}>
          <path d="M4 9v6h4l5 4V5L8 9z" />
          <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
        </svg>
      );
    case 'speakerOff':
      return (
        <svg {...common} width={22} height={22}>
          <path d="M4 9v6h4l5 4V5L8 9z" />
          <path d="M17 9l4 6M21 9l-4 6" />
        </svg>
      );
    case 'camera':
      return (
        <svg {...common}>
          <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      );
    case 'map':
      return (
        <svg {...common}>
          <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" />
          <path d="M9 4v14M15 6v14" />
        </svg>
      );
    case 'arrow':
      return (
        <svg {...common}>
          <path d="M12 3l7 17-7-4-7 4z" />
        </svg>
      );
    case 'list':
      return (
        <svg {...common}>
          <path d="M8 6h12M8 12h12M8 18h12" />
          <path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={3} />
        </svg>
      );
    case 'play':
      return (
        <svg {...common} width={22} height={22} fill="currentColor" stroke="none">
          <path d="M8 5v14l11-7z" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common} width={22} height={22} fill="currentColor" stroke="none">
          <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
        </svg>
      );
    case 'flag':
      return (
        <svg {...common} width={20} height={20}>
          <path d="M6 21V4" />
          <path d="M6 4h11l-2 4 2 4H6" />
        </svg>
      );
    case 'warn':
      return (
        <svg {...common} width={16} height={16}>
          <path d="M12 3 2 21h20z" />
          <path d="M12 10v5M12 18v.5" />
        </svg>
      );
    case 'dot':
    default:
      return (
        <svg {...common} width={10} height={10} fill="currentColor" stroke="none">
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}

function Needle({ size, angle, mini }: { size: number; angle: number; mini?: boolean }) {
  return (
    <svg
      className={`xhud__needle${mini ? ' xhud__needle--mini' : ''}`}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      style={{ transform: `rotate(${angle}deg)` }}
    >
      <path d={NEEDLE_PATH} />
    </svg>
  );
}

export default function ExploreScreen({ nav, sensors, lang, muted, onToggleMute, onEnd, onReport, headingRef, destination }: ExploreScreenProps) {
  const { t } = useTranslation();
  const camera = useCamera(true);
  const [view, setView] = useState<ExploreView>(readView);
  const { state } = nav;
  const { session, currentStep, currentIndex, distanceToStep, position, projection, progress, arrived, simulating, needsSimulation, gps, offRoute } = state;
  const { liveText } = useAnnouncer(nav, lang, muted);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  useEffect(() => {
    const id = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [headingRef]);

  // Bearing to the next step and the device heading (compass; else direction of travel; else the route's direction).
  const compass = sensors.orientation?.heading ?? null;
  const geometry = useMemo(() => {
    if (!session || !position || !currentStep) return { target: null as number | null, delta: null as number | null };
    const [lon, lat] = currentStep.location;
    const target = bearing(position, { lat, lon });
    const heading = compass ?? position.heading ?? (projection ? bearingAlong(session.line, projection.along) : null);
    if (heading === null) return { target, delta: null as number | null };
    return { target, delta: Math.round(angleDiff(target, heading)) };
  }, [session, position, currentStep, compass, projection]);
  const delta = arrived ? 0 : geometry.delta;

  // Continuous rotation: never spin the long way round (StrictMode-safe: the update is idempotent).
  const [spin, setSpin] = useState(0);
  useEffect(() => {
    if (delta === null) return;
    setSpin((prev) => continuousAngle(prev, delta));
  }, [delta]);

  if (!session) return null;

  const dist = formatDistance(arrived ? 0 : distanceToStep);
  const distText = `${dist.value} ${t(`units.${dist.unit}`)}`;
  const type = arrived ? 'arrive' : stepTypeOf(currentStep?.type ?? 'straight');
  const warnings = arrived ? [] : (currentStep?.warnings ?? []);
  const impassable = warnings.some((w) => w.impassable_for_profile);
  const steps = session.route.steps ?? [];
  const arriveStreet = stepStreet(steps[steps.length - 1] ?? null, lang);
  const destName = (destination && !COORDS_RE.test(destination.trim()) ? destination : null) ?? arriveStreet ?? t('route.destination');
  const subtitle = `${t(`route.profile.${session.route.profile}`)} · ${t('mode.explore.title')}`;
  const headingSource = compass !== null ? 'compass' : position?.heading !== null && position?.heading !== undefined ? 'travel' : 'route';
  const instruction = arrived ? t('nav.say.arrive') : stepInstruction(currentStep, lang);
  const spoken = arrived || !instruction ? instruction : distanceToStep >= 15 ? t('nav.say.stepIn', { distance: Math.round(distanceToStep / 5) * 5, instruction }) : instruction;
  const warningLine = warnings.length
    ? warnings.map((w) => t(w.impassable_for_profile ? 'nav.say.warningImpassable' : 'nav.say.warning', { name: warningName(w, lang) })).join(' ')
    : null;

  let caption: string;
  if (arrived) caption = t('step.short.arrive');
  else if (delta === null) caption = `${t(`step.short.${type}`)} · ${distText}`;
  else if (Math.abs(delta) <= STRAIGHT_DEG) caption = t('explore.straight', { dist: distText });
  else caption = t('explore.turn', { deg: Math.abs(delta), dir: t(delta < 0 ? 'explore.left' : 'explore.right'), dist: distText });

  const live = camera.state === 'live';
  const showVideo = camera.state !== 'fallback' && view !== 'map';
  const simple = view === 'arrow';
  const statusKind: 'live' | 'sim' | 'wait' = simulating ? 'sim' : gps === 'ok' ? 'live' : 'wait';
  const statusText = [session.route.synthetic ? t('explore.demo') : null, t(simulating ? 'explore.simulated' : gps === 'ok' ? 'explore.live' : 'explore.noGps')].filter(Boolean).join(' · ');
  const pct = Math.round(progress * 100);
  const tripMin = Math.round((Date.now() - session.startedAt) / 60000);
  const confLabel = t(`confidence.${session.route.confidence?.label ?? 'low'}`);

  const viewIcon: Record<ExploreView, ReactNode> = { camera: <Icon name="camera" />, map: <Icon name="map" />, arrow: <Icon name="arrow" />, steps: <Icon name="list" /> };

  return (
    <div className={`xhud${simple ? ' xhud--simple' : ''}${live ? ' xhud--live' : ' xhud--nocam'}`} lang={lang}>
      <header className="xhud__top" ref={headingRef as RefObject<HTMLElement>} tabIndex={-1} role="group" aria-label={t('explore.title')}>
        <div className="xhud__toprow">
          <button type="button" className="xhud__iconbtn" aria-label={t('explore.back')} onClick={onEnd}>
            <Icon name="back" />
          </button>
          <div className="xhud__mission">
            <span className="xhud__eyebrow">{t('explore.destination')}</span>
            <strong className="xhud__missionName">{destName}</strong>
          </div>
          <button type="button" className="xhud__iconbtn" aria-pressed={!muted} aria-label={muted ? t('nav.unmute') : t('nav.mute')} onClick={onToggleMute}>
            <Icon name={muted ? 'speakerOff' : 'speaker'} />
          </button>
        </div>

        <div className="xhud__titlerow">
          <div className="xhud__titles">
            <h2 className="xhud__title">{destName}</h2>
            <p className="xhud__sub">{subtitle}</p>
          </div>
          <div className="xhud__distpill" role="group" aria-label={t('explore.distanceLabel')}>
            <span className="xhud__minidisc" aria-hidden="true">
              <Needle size={22} angle={spin} mini />
            </span>
            <span className="xhud__distcol">
              <span className="xhud__bigdist">
                {dist.value}
                <span className="xhud__bigunit">{t(`units.${dist.unit}`)}</span>
              </span>
              <span className="xhud__bearing">{geometry.target === null ? t('explore.bearingUnknown') : t('explore.bearing', { deg: Math.round(geometry.target) })}</span>
            </span>
          </div>
        </div>

        <div className="xhud__progress">
          <span className="xhud__eyebrow">{t('explore.start')}</span>
          <div className="xhud__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('nav.progress')}>
            <span className="xhud__fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="xhud__eyebrow">{t('explore.arrive')}</span>
        </div>
      </header>

      <div className="xhud__cam">
        {camera.state !== 'fallback' && (
          <video ref={camera.videoRef} className={`xhud__video${showVideo ? '' : ' xhud__video--hidden'}`} playsInline muted autoPlay aria-label={t('capture.preview')} />
        )}
        <div className="xhud__shade" aria-hidden="true" />

        <div className="xhud__switch" role="group" aria-label={t('explore.view.label')}>
          {VIEWS.map((v) => (
            <button key={v} type="button" className="xhud__seg" aria-pressed={view === v} onClick={() => setView(v)}>
              {viewIcon[v]}
              <span className="xhud__seglabel">{t(`explore.view.${v}`)}</span>
              {v === 'camera' && live && <span className="xhud__livedot" aria-hidden="true" />}
            </button>
          ))}
        </div>

        {!simple && (
          <div className="xhud__statusrow">
            <p className={`xhud__status xhud__status--${statusKind}`} role="status">
              <span className={`xhud__statusdot xhud__statusdot--${statusKind}`} aria-hidden="true" />
              {statusText}
            </p>
            {simulating && (
              <>
                <button
                  type="button"
                  className="xhud__pillbtn"
                  onClick={() => nav.setSimSpeed(SIM_SPEEDS[(SIM_SPEEDS.indexOf(state.simSpeed) + 1) % SIM_SPEEDS.length])}
                  aria-label={t('nav.simSpeed', { speed: state.simSpeed })}
                >
                  ×{state.simSpeed}
                </button>
                <button type="button" className="xhud__pillbtn" onClick={nav.stopSimulation}>
                  {t('nav.simStop')}
                </button>
              </>
            )}
            {!simulating && needsSimulation && (
              <button type="button" className="xhud__pillbtn xhud__pillbtn--primary" onClick={nav.startSimulation}>
                {t('nav.simulate')}
              </button>
            )}
          </div>
        )}
        {!simple && !simulating && needsSimulation && (
          <p className="sr-only" role="status">
            {offRoute && gps === 'ok' ? t('nav.farFromRoute') : t(`nav.gps.${gps}`)}
          </p>
        )}
        {camera.state === 'fallback' && view === 'camera' && !simple && <p className="xhud__nocam">{t('explore.noCamera')}</p>}

        {view === 'steps' ? (
          <ol className="xhud__steps" aria-label={t('explore.stepsList')}>
            {steps.map((s, i) => {
              const d = formatDistance(s.distance_m);
              const street = stepStreet(s, lang);
              const current = !arrived && i === currentIndex;
              return (
                <li key={s.index ?? i} className={`xhud__step${current ? ' xhud__step--current' : ''}${i < currentIndex && !arrived ? ' xhud__step--done' : ''}`} aria-current={current ? 'step' : undefined}>
                  <StepGlyph type={s.type} size={32} className="xhud__stepglyph" />
                  <span className="xhud__steptext">
                    <span>{stepInstruction(s, lang)}</span>
                    {street && <span className="xhud__stepstreet">{street}</span>}
                  </span>
                  <span className="xhud__stepdist">
                    {i === 0 ? '' : `${d.value} ${t(`units.${d.unit}`)}`}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="xhud__centre">
            <div className="xhud__disc" aria-hidden="true">
              <Needle size={64} angle={spin} />
            </div>
            <p className="xhud__caption">
              <StepGlyph type={type} size={28} className="xhud__captionglyph" />
              <span>{caption}</span>
            </p>
          </div>
        )}
        <p className="sr-only" aria-live="assertive" aria-atomic="true">
          {liveText} {delta !== null && !arrived ? t('explore.arrowSr', { deg: ((delta % 360) + 360) % 360 }) : ''}
        </p>

        {!simple && view !== 'steps' && <div className="xhud__ground" aria-hidden="true" />}

        {!simple && (
          <div className="xhud__bottom">
            {arrived ? (
              <section className="xhud__card xhud__card--arrived" role="status" aria-label={t('nav.arrivedTitle')}>
                <div className="xhud__cardrow">
                  <span className="xhud__tile" aria-hidden="true">
                    <Icon name="flag" />
                  </span>
                  <div className="xhud__cardtext">
                    <span className="xhud__eyebrow">{t('explore.arrived')}</span>
                    <p className="xhud__cardline xhud__cardline--strong">{t('nav.arrivedTitle')}</p>
                    <p className="xhud__cardline xhud__cardline--muted">
                      {(session.route.length_m / 1000).toFixed(2)} {t('units.km')} · {tripMin} {t('units.min')} · {t('confidence.title')} {confLabel}
                    </p>
                  </div>
                </div>
                <button type="button" className="xhud__btn xhud__btn--primary" onClick={onEnd}>
                  {t('explore.finish')}
                </button>
              </section>
            ) : (
              <section className="xhud__card" aria-label={t('explore.says')} onDoubleClick={nav.repeat}>
                <div className="xhud__cardrow">
                  <span className="xhud__tile" aria-hidden="true">
                    <StepGlyph type={type} size={26} />
                  </span>
                  <div className="xhud__cardtext">
                    <span className="xhud__eyebrow">{t('explore.says')}</span>
                    <p className="xhud__cardline xhud__cardline--strong">{spoken || t(`step.short.${type}`)}</p>
                    {warningLine && (
                      <p className={`xhud__cardline xhud__cardline--warn${impassable ? ' xhud__cardline--impassable' : ''}`}>
                        <span className={`xhud__warnicon${impassable ? ' xhud__warnicon--impassable' : ''}`}>
                          <Icon name="warn" />
                        </span>
                        <span className="sr-only">{t('nav.warningsLabel')}: </span>
                        {warningLine}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="xhud__iconbtn xhud__iconbtn--voice"
                    aria-pressed={!muted}
                    aria-label={muted ? t('nav.unmute') : t('nav.mute')}
                    onClick={() => {
                      onToggleMute();
                      if (muted) nav.repeat();
                    }}
                  >
                    <Icon name={muted ? 'play' : 'pause'} />
                  </button>
                </div>
              </section>
            )}
            <div className="xhud__actions" role="group" aria-label={t('nav.controls')}>
              <button type="button" className="xhud__btn" onClick={onReport}>
                {t('report.fab')}
              </button>
              <button type="button" className="xhud__btn" onClick={onEnd}>
                {t('nav.end')}
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="sr-only">{t(`explore.heading.${headingSource}`)}</p>
    </div>
  );
}
