import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedName, PROFILES, RISKS, routeApi, type Profile, type Risk, type SearchResult } from '../api';
import type { Lang } from '../i18n';
import { formatCoords, type PlannerPoint, type PointRole, type RoutePlannerApi } from '../routePlanner';

const SEARCH_DEBOUNCE_MS = 300;
const PROFILE_GLYPHS: Record<Profile, string> = {
  walker: '🚶',
  wheelchair_manual: '♿',
  elderly_walking_aid: '🧓',
  pram: '🍼',
};

type GeoErrorKey = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

// ---------- Place field: combobox + listbox, "Pick on map", "Use my location" ----------

interface PlaceFieldProps {
  role: PointRole;
  point: PlannerPoint | null;
  pickActive: boolean;
  lang: Lang;
  allowGeolocation: boolean;
  onSelect: (point: PlannerPoint | null) => void;
  onTogglePick: () => void;
  onAnnounce: (text: string) => void;
}

function PlaceField({ role, point, pickActive, lang, allowGeolocation, onSelect, onTogglePick, onAnnounce }: PlaceFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const statusId = `${id}-status`;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [active, setActive] = useState(-1);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<GeoErrorKey | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fieldName = t(`route.${role}`);

  // Keep the visible text in sync when the point is set from elsewhere (map pick, demo, my location).
  useEffect(() => {
    setQuery(point ? point.label : '');
    setOpen(false);
    setActive(-1);
  }, [point]);

  // Debounced search.
  useEffect(() => {
    abortRef.current?.abort();
    const q = query.trim();
    if (q.length < 2 || (point && q === point.label)) {
      setResults([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    const timer = window.setTimeout(() => {
      setSearching(true);
      routeApi
        .search(q, 8, ac.signal)
        .then((res) => {
          if (ac.signal.aborted) return;
          setResults(res.results);
          setSearchFailed(false);
          setOpen(true);
          setActive(res.results.length > 0 ? 0 : -1);
        })
        .catch(() => {
          if (ac.signal.aborted) return;
          setResults([]);
          setSearchFailed(true);
          setOpen(true);
        })
        .finally(() => {
          if (!ac.signal.aborted) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query, point]);

  const choose = useCallback(
    (r: SearchResult) => {
      const label = localizedName(r, lang);
      onSelect({ lat: r.lat, lon: r.lon, label });
      setOpen(false);
      onAnnounce(t('route.pickSet', { field: fieldName, coords: label }));
    },
    [lang, onSelect, onAnnounce, t, fieldName],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open && results.length > 0) setOpen(true);
      setActive((i) => (results.length === 0 ? -1 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? -1 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && results[active]) {
        e.preventDefault();
        choose(results[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        // Close the suggestions first; a second Escape reaches the panel and closes it.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setGeoError('unsupported');
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude: lat, longitude: lon } = pos.coords;
        onSelect({ lat, lon, label: t('route.myLocation') });
        onAnnounce(t('route.pickSet', { field: fieldName, coords: formatCoords(lat, lon) }));
      },
      (err) => {
        setLocating(false);
        setGeoError(err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  };

  const showList = open && query.trim().length >= 2;

  return (
    <div className="place">
      <label className="field__label" htmlFor={inputId}>
        {fieldName}
      </label>
      <div className="place__row">
        <input
          ref={inputRef}
          id={inputId}
          className="place__input"
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={statusId}
          aria-label={t(`route.${role}Search`)}
          placeholder={t('route.searchPlaceholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (point && e.target.value !== point.label) onSelect(null);
          }}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {point && (
          <button
            type="button"
            className="btn btn--icon"
            aria-label={t('route.clearPoint', { field: fieldName })}
            onClick={() => {
              onSelect(null);
              inputRef.current?.focus();
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      {showList && (
        <ul id={listId} className="place__list" role="listbox" aria-label={t(`route.${role}Search`)}>
          {results.map((r, i) => {
            const subtitle = lang === 'hi' ? r.subtitle_hi || r.subtitle_en : r.subtitle_en || r.subtitle_hi;
            return (
              <li
                key={`${r.kind}-${r.id}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="place__option"
                lang={lang}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(r)}
                onMouseEnter={() => setActive(i)}
              >
                <span className="place__optionName">{localizedName(r, lang)}</span>
                <span className="place__optionMeta">
                  {t(`route.kind.${r.kind}`, { defaultValue: String(r.kind) })}
                  {subtitle ? ` · ${subtitle}` : ''}
                </span>
              </li>
            );
          })}
          {results.length === 0 && (
            <li className="place__empty" role="option" aria-selected={false} aria-disabled="true">
              {searchFailed ? t('route.errors.generic') : t('route.noResults')}
            </li>
          )}
        </ul>
      )}
      <p id={statusId} className="place__status" role="status" aria-live="polite">
        {searching
          ? t('route.searching')
          : showList && results.length > 0
            ? t('route.resultsCount', { count: results.length })
            : point
              ? t('route.setTo', { label: formatCoords(point.lat, point.lon) })
              : t('route.notSet')}
      </p>
      <div className="place__actions">
        <button type="button" className="btn" aria-pressed={pickActive} onClick={onTogglePick}>
          {t('route.pickOnMap')}
        </button>
        {allowGeolocation && (
          <button type="button" className="btn" onClick={useMyLocation} disabled={locating} aria-busy={locating}>
            {locating ? t('route.locating') : t('route.useMyLocation')}
          </button>
        )}
      </div>
      {pickActive && <p className="place__hint">{t('route.pickHint', { field: fieldName.toLocaleLowerCase() })}</p>}
      {geoError && (
        <p className="place__error" role="alert">
          {t(`sensors.geoError.${geoError}`)}
        </p>
      )}
    </div>
  );
}

// ---------- Planner panel ----------

interface RoutePlannerProps {
  planner: RoutePlannerApi;
  lang: Lang;
  onClose: () => void;
  /** Receives the heading element so the opener can move focus to it. */
  headingRef: RefObject<HTMLHeadingElement>;
}

export default function RoutePlanner({ planner, lang, onClose, headingRef }: RoutePlannerProps) {
  const { t } = useTranslation();
  const { state } = planner;
  const [announcement, setAnnouncement] = useState('');
  const id = useId();

  const announce = useCallback((text: string) => {
    // Clear first so repeating the same text is re-announced.
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

  const canCompare = Boolean(state.origin && state.destination);

  return (
    <div className="panel__inner planner">
      <div className="panel__head">
        <h2 id="route-title" className="panel__title" ref={headingRef} tabIndex={-1}>
          {t('route.title')}
        </h2>
        <button type="button" className="btn btn--icon" onClick={onClose} aria-label={t('panels.close')}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <p className="panel__hint">{t('route.intro')}</p>

      <button type="button" className="btn btn--primary planner__demo" onClick={planner.runDemo} aria-busy={state.loading}>
        <span aria-hidden="true">♿ </span>
        {t('route.demoButton')}
      </button>
      <p className="panel__hint">{t('route.demoHint')}</p>

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
      <PlaceField
        role="destination"
        point={state.destination}
        pickActive={state.pickMode === 'destination'}
        lang={lang}
        allowGeolocation={false}
        onSelect={(p) => planner.setPoint('destination', p)}
        onTogglePick={() => planner.togglePick('destination')}
        onAnnounce={announce}
      />

      <fieldset className="choices">
        <legend className="field__label">{t('route.profile.label')}</legend>
        {PROFILES.map((p) => (
          <label key={p} className="choice">
            <input type="radio" name={`${id}-profile`} value={p} checked={state.profile === p} onChange={() => planner.setProfile(p)} />
            <span className="choice__glyph" aria-hidden="true">
              {PROFILE_GLYPHS[p]}
            </span>
            <span className="choice__text">{t(`route.profile.${p}`)}</span>
          </label>
        ))}
      </fieldset>

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
        <input
          id={`${id}-time`}
          type="time"
          value={state.time}
          onChange={(e) => planner.setTime(e.target.value || state.time)}
          aria-describedby={`${id}-time-hint`}
        />
        <p id={`${id}-time-hint`} className="place__hint">
          {t('route.departHint')}
        </p>
      </div>

      <div className="planner__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={planner.compare}
          disabled={!canCompare}
          aria-busy={state.loading}
          aria-describedby={!state.origin || !state.destination ? `${id}-compare-hint` : undefined}
        >
          {t('route.compare')}
        </button>
        {state.result && (
          <button type="button" className="btn" onClick={planner.clear}>
            {t('route.clearResult')}
          </button>
        )}
      </div>
      {(!state.origin || !state.destination) && (
        <p id={`${id}-compare-hint`} className="place__hint">
          {t('route.compareDisabled')}
        </p>
      )}

      <p className="place__status" role="status" aria-live="polite">
        {state.loading ? t('route.loading') : announcement}
      </p>
      {state.error && (
        <p className="place__error" role="alert">
          {t(`route.errors.${state.error}`)}
        </p>
      )}
    </div>
  );
}
