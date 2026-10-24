// Place search field: a `role="combobox"` input (debounced `GET /search`), a
// listbox of results with Up/Down/Enter/Escape, "Pick on map" and, for the
// origin, "Use my location". Shared by the Home sheet and the Listen screen.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedName, routeApi, type SearchResult } from '../api';
import type { Lang } from '../i18n';
import { formatCoords, type PlannerPoint, type PointRole } from '../routePlanner';

const SEARCH_DEBOUNCE_MS = 300;

type GeoErrorKey = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export interface PlaceFieldProps {
  role: PointRole;
  point: PlannerPoint | null;
  pickActive: boolean;
  lang: Lang;
  allowGeolocation: boolean;
  onSelect: (point: PlannerPoint | null) => void;
  onTogglePick: () => void;
  onAnnounce: (text: string) => void;
  /** Big rounded search-bar look (Home) instead of the plain form field. */
  big?: boolean;
  autoFocus?: boolean;
  /** Hide the "Pick on map" / "Use my location" row (the caller shows its own actions). */
  hideActions?: boolean;
}

export default function PlaceField({
  role,
  point,
  pickActive,
  lang,
  allowGeolocation,
  onSelect,
  onTogglePick,
  onAnnounce,
  big = false,
  autoFocus = false,
  hideActions = false,
}: PlaceFieldProps) {
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
  const inputRef = useRef<HTMLInputElement>(null);

  const fieldName = t(`route.${role}`);

  // Keep the visible text in sync when the point is set from elsewhere (map pick, demo, my location).
  useEffect(() => {
    setQuery(point ? point.label : '');
    setOpen(false);
    setActive(-1);
  }, [point]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Debounced search; the AbortController cancels the previous request (StrictMode-safe).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || (point && q === point.label)) {
      setResults([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    const ac = new AbortController();
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
    <div className={`place${big ? ' place--big' : ''}`}>
      <label className={big ? 'sr-only' : 'field__label'} htmlFor={inputId}>
        {fieldName}
      </label>
      <div className="place__row">
        {big && (
          <span className="place__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" focusable="false">
              <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
              <path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </span>
        )}
        <input
          ref={inputRef}
          id={inputId}
          className="place__input"
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={statusId}
          aria-label={t(`route.${role}Search`)}
          placeholder={big ? t('home.whereTo') : t('route.searchPlaceholder')}
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
            className="btn btn--icon btn--ghost"
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
      <p id={statusId} className={big ? 'sr-only' : 'place__status'} role="status" aria-live="polite">
        {searching
          ? t('route.searching')
          : showList && results.length > 0
            ? t('route.resultsCount', { count: results.length })
            : point
              ? t('route.setTo', { label: formatCoords(point.lat, point.lon) })
              : t('route.notSet')}
      </p>
      {!hideActions && (
        <div className="place__actions">
          <button type="button" className="btn btn--small" aria-pressed={pickActive} onClick={onTogglePick}>
            {t('route.pickOnMap')}
          </button>
          {allowGeolocation && (
            <button type="button" className="btn btn--small" onClick={useMyLocation} disabled={locating} aria-busy={locating}>
              {locating ? t('route.locating') : t('route.useMyLocation')}
            </button>
          )}
        </div>
      )}
      {pickActive && <p className="place__hint">{t('route.pickHint', { field: fieldName.toLocaleLowerCase() })}</p>}
      {geoError && (
        <p className="place__error" role="alert">
          {t(`sensors.geoError.${geoError}`)}
        </p>
      )}
    </div>
  );
}
