// Explore mode (dyslexic / autistic travellers): the camera feed full screen,
// one huge arrow rotated to (bearing to the next step - compass heading),
// snapping to eight directions, a large pictogram for the step type, at most
// four words, the distance as a big number. Calm colours, no animation beyond
// the arrow rotation (none under reduced motion). "Simplify" keeps only the
// arrow and the distance. Same step engine as Navigate.
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useCamera } from '../camera';
import { angleDiff, bearing, bearingAlong, formatDistance, snapToEight } from '../geo';
import type { Lang } from '../i18n';
import { SIM_SPEEDS, type NavigationApi } from '../navigation';
import type { Sensors } from '../sensors';
import StepGlyph, { BigArrow, stepTypeOf } from './StepGlyph';
import { useAnnouncer } from './useAnnouncer';

interface ExploreScreenProps {
  nav: NavigationApi;
  sensors: Sensors;
  lang: Lang;
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  onReport: () => void;
  headingRef: RefObject<HTMLElement>;
}

const SIMPLIFY_KEY = 'samaan.explore.simplify';

function readSimplify(): boolean {
  try {
    return localStorage.getItem(SIMPLIFY_KEY) === '1';
  } catch {
    return false;
  }
}

export default function ExploreScreen({ nav, sensors, lang, muted, onToggleMute, onEnd, onReport, headingRef }: ExploreScreenProps) {
  const { t } = useTranslation();
  const camera = useCamera(true);
  const [simplify, setSimplify] = useState(readSimplify);
  const { state } = nav;
  const { session, currentStep, distanceToStep, position, projection, arrived, simulating, needsSimulation, gps, offRoute } = state;
  const { liveText } = useAnnouncer(nav, lang, muted);

  useEffect(() => {
    try {
      localStorage.setItem(SIMPLIFY_KEY, simplify ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [simplify]);

  useEffect(() => {
    const id = window.setTimeout(() => headingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [headingRef]);

  // Arrow rotation: bearing to the next step minus the device heading (compass; else the direction of travel).
  const compass = sensors.orientation?.heading ?? null;
  const rotation = useMemo(() => {
    if (!session || !position || !currentStep) return 0;
    const [lon, lat] = currentStep.location;
    const target = bearing(position, { lat, lon });
    const heading = compass ?? position.heading ?? (projection ? bearingAlong(session.line, projection.along) : null);
    if (heading === null) return 0;
    return snapToEight(angleDiff(target, heading));
  }, [session, position, currentStep, compass, projection]);

  if (!session) return null;
  const dist = formatDistance(distanceToStep);
  const type = arrived ? 'arrive' : stepTypeOf(currentStep?.type ?? 'straight');
  const warnings = currentStep?.warnings ?? [];
  const impassable = warnings.some((w) => w.impassable_for_profile);
  const words = arrived ? t('step.short.arrive') : t(`step.short.${type}`);
  const headingSource = compass !== null ? 'compass' : position?.heading !== null && position?.heading !== undefined ? 'travel' : 'route';

  return (
    <div className={`explore${simplify ? ' explore--simple' : ''}`}>
      {camera.state !== 'fallback' && <video ref={camera.videoRef} className="explore__video" playsInline muted autoPlay aria-label={t('capture.preview')} />}

      <div className="explore__top" ref={headingRef as RefObject<HTMLDivElement>} tabIndex={-1} role="group" aria-label={t('explore.title')}>
        <p className="explore__dist" lang={lang}>
          <span className="explore__num">{arrived ? '0' : dist.value}</span>
          <span className="explore__unit"> {t(`units.${dist.unit}`)}</span>
        </p>
        {!simplify && (
          <p className="explore__words" lang={lang}>
            {words}
          </p>
        )}
      </div>

      <div className="explore__arrow" style={{ transform: `rotate(${rotation}deg)` }} aria-hidden="true">
        <BigArrow size={230} />
      </div>
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {liveText} {t('explore.arrowSr', { deg: Math.round(rotation) })}
      </p>

      {!simplify && (
        <div className="explore__picto" aria-hidden="true">
          <StepGlyph type={type} size={72} />
        </div>
      )}
      {warnings.length > 0 && !arrived && (
        <p className={`explore__warn${impassable ? ' explore__warn--impassable' : ''}`} role="status">
          <span aria-hidden="true">⚠</span>
          <span className="sr-only">{t('nav.warningsLabel')}: </span>
          {!simplify && warnings.map((w) => (lang === 'hi' ? w.name_hi || w.name_en : w.name_en)).join(', ')}
        </p>
      )}

      {(simulating || needsSimulation) && (
        <div className={`simbar simbar--explore${simulating ? ' simbar--on' : ''}`} role="status">
          {simulating ? (
            <>
              <span className="simbar__text">{t('nav.simulating', { speed: state.simSpeed })}</span>
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

      {camera.state === 'fallback' && <p className="explore__nocam">{t('explore.noCamera')}</p>}
      <div className="explore__bar" role="group" aria-label={t('nav.controls')}>
        <button type="button" className="btn explore__btn" aria-pressed={simplify} onClick={() => setSimplify((v) => !v)}>
          {t('explore.simplify')}
        </button>
        <button type="button" className="btn explore__btn" aria-pressed={!muted} onClick={onToggleMute}>
          {muted ? t('nav.unmute') : t('nav.mute')}
        </button>
        {!simplify && (
          <button type="button" className="btn explore__btn" onClick={onReport}>
            {t('report.fab')}
          </button>
        )}
        <button type="button" className="btn explore__btn explore__btn--end" onClick={onEnd}>
          {t('nav.end')}
        </button>
      </div>
      {!simplify && <p className="explore__src sr-only">{t(`explore.heading.${headingSource}`)}</p>}
    </div>
  );
}
