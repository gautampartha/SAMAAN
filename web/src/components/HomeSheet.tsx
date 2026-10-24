// Home: greeting, "Where to?" search, the three mode cards (Move / Explore /
// Listen), the profile chip, options (origin, risk, departure time) and the
// Go / demo buttons. A bottom sheet over the map.
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { RISKS, type AppMode, type Risk } from '../api';
import type { Lang } from '../i18n';
import { APP_MODES } from '../mode';
import { hrefFor } from '../router';
import { formatCoords, type RoutePlannerApi } from '../routePlanner';
import { useUser } from '../user';
import type { GeoErrorKind, GeoFix } from '../sensors';
import { Icon, PROFILE_ICONS } from '../icons';
import PlaceField from './PlaceField';

export type GoError = 'noDestination' | 'geoDenied' | 'geoUnavailable' | null;

interface HomeSheetProps {
  planner: RoutePlannerApi;
  lang: Lang;
  mode: AppMode;
  onMode: (mode: AppMode) => void;
  onGo: () => void;
  onDemo: () => void;
  onReport: () => void;
  /** Live GPS fix (null until the first one) and its error, for the From row. */
  fix: GeoFix | null;
  geoError: GeoErrorKind | null;
  goBusy: boolean;
  goError: GoError;
  headingRef: RefObject<HTMLHeadingElement>;
  /** Shown as the heading when Home is rendered on #/navigate, #/explore without a trip. */
  compact?: boolean;
}

const MODE_ICONS: Record<AppMode, JSX.Element> = {
  move: (
    <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="19" cy="33" r="9" />
      <circle cx="37" cy="37" r="4" />
      <path d="M19 33 V14 h10 l5 10 h6" />
      <circle cx="20" cy="7" r="3" fill="currentColor" stroke="none" />
    </svg>
  ),
  explore: (
    <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="10" width="36" height="28" rx="5" />
      <path d="M24 32 V17 M17 24 l7-7 7 7" />
    </svg>
  ),
  listen: (
    <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22 a12 12 0 0 1 24 0 v12 a4 4 0 0 1 -4 4 h-2 v-12 h6 M12 22 v12 a4 4 0 0 0 4 4 h2 v-12 h-6" />
      <path d="M22 44 h4" />
    </svg>
  ),
};

export default function HomeSheet({ planner, lang, mode, onMode, onGo, onDemo, onReport, fix, geoError, goBusy, goError, headingRef, compact = false }: HomeSheetProps) {
  const { t } = useTranslation();
  const id = useId();
  const user = useUser();
  const { state } = planner;
  const [announcement, setAnnouncement] = useState('');
  const [originOpen, setOriginOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const announce = useCallback((text: string) => {
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(text), 50);
  }, []);

  // Announce map picks (they happen outside this component).
  const prevRef = useRef({ origin: state.origin, destination: state.destination });
  useEffect(() => {
    const prev = prevRef.current;
    for (const role of ['origin', 'destination'] as const) {
      const p = state[role];
      if (p && p !== prev[role] && p.label === formatCoords(p.lat, p.lon)) {
        announce(t('route.pickSet', { field: t(`route.${role}`), coords: p.label }));
      }
    }
    prevRef.current = { origin: state.origin, destination: state.destination };
  }, [state.origin, state.destination, announce, t]);

  const profile = state.profiles.find((p) => p.id === state.profile);
  const profileName = profile ? (lang === 'hi' ? profile.name_hi || profile.name_en : profile.name_en) : t(`route.profile.${state.profile}`);
  const greetingName = user?.display_name;

  return (
    <section className="sheet-home" aria-labelledby={`${id}-title`}>
      <div className="grabber" aria-hidden="true" />
      <h2 id={`${id}-title`} className="sheet-home__greeting" ref={headingRef} tabIndex={-1}>
        {compact ? t('home.whereTo') : greetingName ? t('home.greetingName', { name: greetingName }) : t('home.greeting')}
      </h2>
      {!compact && <p className="sheet-home__sub">{t('home.whereTo')}</p>}

      <PlaceField
        role="destination"
        point={state.destination}
        pickActive={state.pickMode === 'destination'}
        lang={lang}
        allowGeolocation={false}
        onSelect={(p) => planner.setPoint('destination', p)}
        onTogglePick={() => planner.togglePick('destination')}
        onAnnounce={announce}
        big
      />

      <div className="from-row">
        <span className="from-row__label">{t('home.from')}:</span>
        <span className="from-row__value">
          {state.origin ? (
            state.origin.label
          ) : fix ? (
            <>
              <span className="livedot" aria-hidden="true" />
              {t('home.fromGpsLive', { m: Math.round(fix.accuracy) })}
            </>
          ) : geoError ? (
            t('home.fromGpsOff')
          ) : (
            t('home.fromGps')
          )}
        </span>
        <button type="button" className="btn btn--small btn--ghost" aria-expanded={originOpen} aria-controls={`${id}-origin`} onClick={() => setOriginOpen((v) => !v)}>
          {t('home.changeOrigin')}
        </button>
      </div>
      {originOpen && (
        <div id={`${id}-origin`} className="from-row__field">
          <PlaceField
            role="origin"
            point={state.origin}
            pickActive={state.pickMode === 'origin'}
            lang={lang}
            allowGeolocation
            onSelect={(p) => planner.setPoint('origin', p)}
            onTogglePick={() => planner.togglePick('origin')}
            onAnnounce={announce}
          />
        </div>
      )}

      <fieldset className="modes">
        <legend className="sr-only">{t('home.modeLabel')}</legend>
        {APP_MODES.map((m) => (
          <label key={m} className={`modecard modecard--${m}`}>
            <input type="radio" name={`${id}-mode`} value={m} checked={mode === m} onChange={() => onMode(m)} aria-label={`${t(`mode.${m}.title`)}: ${t(`mode.${m}.line`)}`} />
            <span className="modecard__icon">{MODE_ICONS[m]}</span>
            <span className="modecard__title">{t(`mode.${m}.title`)}</span>
            <span className="modecard__line">{t(`mode.${m}.line`)}</span>
          </label>
        ))}
      </fieldset>

      <p className="profilechip">
        <span aria-hidden="true" className="profilechip__glyph">
          <Icon name={PROFILE_ICONS[state.profile] ?? 'wheelchair'} size={20} />
        </span>
        <span className="profilechip__text">
          <span className="sr-only">{t('route.profile.label')}: </span>
          {profileName}
        </span>
        <a className="btn btn--small btn--ghost" href={hrefFor('settings')}>
          {t('user.change')}
        </a>
      </p>

      <button type="button" className="btn btn--ghost sheet-home__options" aria-expanded={optionsOpen} aria-controls={`${id}-options`} onClick={() => setOptionsOpen((v) => !v)}>
        {t('home.options')}
      </button>
      {optionsOpen && (
        <div id={`${id}-options`} className="options">
          <fieldset className="choices">
            <legend className="field__label">{t('route.risk.label')}</legend>
            {RISKS.map((r: Risk) => (
              <label key={r} className="choice choice--stacked">
                <input type="radio" name={`${id}-risk`} value={r} checked={state.risk === r} onChange={() => planner.setRisk(r)} />
                <span className="choice__text">
                  <span className="choice__name">{t(`route.risk.${r}`)}</span>
                  <span className="choice__hint">{t(`route.risk.${r}Hint`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-time`}>
              {t('route.depart')}
            </label>
            <input id={`${id}-time`} type="time" value={state.time} onChange={(e) => planner.setTime(e.target.value || state.time)} aria-describedby={`${id}-time-hint`} />
            <p id={`${id}-time-hint`} className="place__hint">
              {t('route.departHint')}
            </p>
          </div>
        </div>
      )}

      <div className="sheet-home__actions">
        <button type="button" className="btn btn--primary btn--big" onClick={onGo} disabled={!state.destination} aria-busy={goBusy || state.loading}>
          {state.loading || goBusy ? t('home.finding') : t(`home.go.${mode}`)}
        </button>
        <button type="button" className="btn btn--big" onClick={onDemo} aria-busy={state.loading}>
          {t('home.demo')}
        </button>
      </div>
      {!state.destination && <p className="place__hint">{t('home.goHint')}</p>}
      <button type="button" className="btn btn--ghost sheet-home__report" onClick={onReport}>
        <Icon name="flag" size={20} /> {t('report.fab')}
      </button>
      <p className="place__status" role="status" aria-live="polite">
        {state.loading ? t('route.loading') : announcement}
      </p>
      {(state.error || goError) && (
        <p className="place__error" role="alert">
          {goError ? t(`home.errors.${goError}`) : t(`route.errors.${state.error}`)}
        </p>
      )}
    </section>
  );
}
