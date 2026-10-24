import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedName, photoUrl, ROUTE_MODES, type RouteBarrier, type RouteMode, type RouteResponse, type RouteResult } from '../api';
import type { Lang } from '../i18n';
import { ROUTE_STYLES, RouteSwatch } from './routeStyles';

interface RouteCompareProps {
  result: RouteResponse;
  selected: RouteMode | null;
  lang: Lang;
  onSelect: (mode: RouteMode) => void;
  /** Opens the report sheet with kind=fixed for this barrier. */
  onReportFixed: (barrier: RouteBarrier) => void;
}

function pct(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- Verified / unknown / blocked stacked bar ----------

function VerifiedBar({ route }: { route: RouteResult }) {
  const { t } = useTranslation();
  const v = pct(route.verified_pct);
  const u = pct(route.unknown_pct);
  const b = pct(route.blocked_pct);
  const label = t('route.verifiedBar', { verified: v, unknown: u }) + (b > 0 ? t('route.blockedPart', { blocked: b }) : '');
  return (
    <div className="vbar">
      <div className="vbar__track" role="img" aria-label={t('route.verifiedBarAlt', { verified: v, unknown: u, blocked: b })}>
        <span className="vbar__seg vbar__seg--verified" style={{ flexGrow: v }} />
        <span className="vbar__seg vbar__seg--unknown" style={{ flexGrow: u }} />
        <span className="vbar__seg vbar__seg--blocked" style={{ flexGrow: b }} />
      </div>
      <p className="vbar__label" aria-hidden="true">
        {label}
      </p>
    </div>
  );
}

// ---------- One barrier row ----------

function BarrierRow({ barrier, lang, onReportFixed }: { barrier: RouteBarrier; lang: Lang; onReportFixed: (b: RouteBarrier) => void }) {
  const { t } = useTranslation();
  const name = localizedName(barrier, lang);
  const photo = barrier.photo_urls?.[0];
  const p = typeof barrier.p_present === 'number' ? barrier.p_present : 1;
  return (
    <li className={`rb${barrier.impassable_for_profile ? ' rb--impassable' : ''}`} lang={lang}>
      {photo && (
        <img className="rb__photo" src={photoUrl(photo)} alt={t('route.photoAlt', { name })} loading="lazy" decoding="async" width={64} height={64} />
      )}
      <div className="rb__text">
        <span className="rb__name">
          <span className={`sev sev--${barrier.severity}`} aria-hidden="true">
            {barrier.severity}
          </span>{' '}
          {name}
        </span>
        <span className="rb__meta">
          {t(`barrierClass.${barrier.class}`, { defaultValue: String(barrier.class) })} · {t('severity.label')} {barrier.severity}:{' '}
          {t(`severity.${barrier.severity}`)} · {barrier.permanent ? t('popup.permanent') : t('popup.temporary')}
        </span>
        {p < 1 && <span className="rb__meta">{t('route.likelyPresent', { pct: Math.round(p * 100) })}</span>}
        {barrier.impassable_for_profile && (
          <span className="rb__flag">
            <span aria-hidden="true">⚠ </span>
            {t('route.impassableFlag')}
          </span>
        )}
        <button type="button" className="btn btn--small rb__fixed" onClick={() => onReportFixed(barrier)} aria-label={`${t('report.titleFixed')}: ${name}`}>
          <span aria-hidden="true">✓ </span>
          {t('report.titleFixed')}
        </button>
      </div>
    </li>
  );
}

// ---------- One route card ----------

interface CardProps {
  mode: RouteMode;
  route: RouteResult | null;
  selected: boolean;
  lang: Lang;
  onSelect: () => void;
  cardRef: (el: HTMLElement | null) => void;
  onReportFixed: (b: RouteBarrier) => void;
}

function RouteCard({ mode, route, selected, lang, onSelect, cardRef, onReportFixed }: CardProps) {
  const { t } = useTranslation();
  const style = ROUTE_STYLES[mode];
  const title = t(`route.mode.${mode}.title`);
  const titleId = `route-card-${mode}-title`;
  const summary = route
    ? t('route.summary', {
        title,
        length: Math.round(route.length_m),
        minutes: Math.round(route.eta_min),
        verified: pct(route.verified_pct),
        barriers: t('route.barriers', { count: route.n_barriers }),
      })
    : t('route.summaryNone', { title });

  const unknownLength = route ? Math.round(route.unknown_stretches.reduce((acc, s) => acc + s.length_m, 0)) : 0;

  return (
    <article
      id={`route-card-${mode}`}
      ref={cardRef}
      className={`rcard rcard--${mode}${selected ? ' rcard--selected' : ''}`}
      aria-labelledby={titleId}
      data-selected={selected || undefined}
    >
      <p className="sr-only">{summary}</p>
      <header className="rcard__head">
        <h3 id={titleId} className="rcard__title">
          <span className="rcard__index" aria-hidden="true">
            {style.index}
          </span>
          <RouteSwatch mode={mode} />
          <span>{title}</span>
          {mode === 'samaan' && <span className="badge badge--recommended">{t('route.recommended')}</span>}
        </h3>
        <p className="rcard__explain">{t(`route.mode.${mode}.explain`)}</p>
        {route?.synthetic && <span className="badge badge--synthetic">{t('badge.synthetic')}</span>}
      </header>

      {route ? (
        <>
          <dl className="rcard__stats">
            <div>
              <dt>{t('route.length')}</dt>
              <dd>
                {Math.round(route.length_m)} {t('units.m')}
              </dd>
            </div>
            <div>
              <dt>{t('route.eta')}</dt>
              <dd>{t('route.minutes', { count: Math.round(route.eta_min) })}</dd>
            </div>
          </dl>

          <VerifiedBar route={route} />

          <p className="rcard__barriers">
            <strong>{t('route.barriers', { count: route.n_barriers })}</strong>
            {route.n_barriers_impassable > 0 && (
              <span className="rcard__impassable">
                <span aria-hidden="true">⚠ </span>
                {t('route.impassable', { count: route.n_barriers_impassable })}
              </span>
            )}
          </p>
          {route.barriers.length > 0 ? (
            <ul className="rb-list">
              {route.barriers.map((b) => (
                <BarrierRow key={b.id} barrier={b} lang={lang} onReportFixed={onReportFixed} />
              ))}
            </ul>
          ) : (
            <p className="rcard__note">{t('route.noBarriers')}</p>
          )}

          <p className="rcard__note">
            {route.n_unknown_stretches > 0
              ? t('route.unknownStretches', { count: route.n_unknown_stretches, length: unknownLength })
              : t('route.noUnknown')}
          </p>

          <button type="button" className="btn rcard__select" aria-pressed={selected} onClick={onSelect}>
            {selected ? t('route.selected') : t('route.select')}
          </button>
        </>
      ) : (
        <p className="rcard__none">{t('route.noRoute')}</p>
      )}
    </article>
  );
}

// ---------- Comparison: tabs + snap strip (phone) / three columns (desktop) ----------

export default function RouteCompare({ result, selected, lang, onSelect, onReportFixed }: RouteCompareProps) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Partial<Record<RouteMode, HTMLElement | null>>>({});
  const [visibleMode, setVisibleMode] = useState<RouteMode>(selected ?? 'samaan');

  // Track which card is in view on the phone strip so the tab buttons stay in sync.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onScroll = () => {
      const w = strip.clientWidth || 1;
      const idx = Math.max(0, Math.min(ROUTE_MODES.length - 1, Math.round(strip.scrollLeft / w)));
      setVisibleMode(ROUTE_MODES[idx]);
    };
    strip.addEventListener('scroll', onScroll, { passive: true });
    return () => strip.removeEventListener('scroll', onScroll);
  }, []);

  const scrollTo = useCallback((mode: RouteMode) => {
    const card = cardRefs.current[mode];
    const strip = stripRef.current;
    if (!card || !strip) return;
    strip.scrollTo({ left: card.offsetLeft - strip.offsetLeft, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    setVisibleMode(mode);
    // Move focus to the card's heading so keyboard users land on it.
    const heading = card.querySelector<HTMLElement>('h3');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
  }, []);

  // Bring the selected card into view when the selection changes from the map.
  useEffect(() => {
    if (!selected) return;
    const card = cardRefs.current[selected];
    const strip = stripRef.current;
    if (!card || !strip || strip.scrollWidth <= strip.clientWidth + 1) return;
    strip.scrollTo({ left: card.offsetLeft - strip.offsetLeft, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [selected]);

  const label = lang === 'hi' ? result.label_hi || result.label_en : result.label_en || result.label_hi;
  const selectedTitle = selected ? t(`route.mode.${selected}.title`) : '';

  return (
    <section className="compare" aria-labelledby="compare-title">
      <div className="compare__head">
        <h2 id="compare-title" className="panel__title">
          {label ?? t('route.compareTitle')}
        </h2>
        <p className="panel__hint">
          {t('route.departureHour', { hour: String(result.departure_hour).padStart(2, '0') })} ·{' '}
          {t(`route.profile.${result.profile}`)} · {t(`route.risk.${result.risk}`)}
          {result.synthetic_overlay && (
            <>
              {' '}
              <span className="badge badge--synthetic">{t('badge.synthetic')}</span>
            </>
          )}
        </p>
        {typeof result.origin.snap_distance_m === 'number' && result.origin.snap_distance_m >= 1 && (
          <p className="panel__hint">{t('route.snapped', { field: t('route.origin'), m: Math.round(result.origin.snap_distance_m) })}</p>
        )}
        {typeof result.destination.snap_distance_m === 'number' && result.destination.snap_distance_m >= 1 && (
          <p className="panel__hint">
            {t('route.snapped', { field: t('route.destination'), m: Math.round(result.destination.snap_distance_m) })}
          </p>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {selected ? t('route.mapSelected', { title: selectedTitle }) : ''}
      </p>

      <div className="compare__tabs" role="group" aria-label={t('route.tabsLabel')}>
        {ROUTE_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="btn compare__tab"
            aria-current={visibleMode === mode ? 'true' : undefined}
            aria-label={t('route.tabLabel', { index: ROUTE_STYLES[mode].index, title: t(`route.mode.${mode}.title`) })}
            onClick={() => scrollTo(mode)}
          >
            <span aria-hidden="true">{ROUTE_STYLES[mode].index} </span>
            {t(`route.mode.${mode}.title`)}
          </button>
        ))}
      </div>

      <div ref={stripRef} className="compare__strip" role="list" aria-label={t('route.cardsLabel')}>
        {ROUTE_MODES.map((mode) => (
          <div key={mode} role="listitem" className="compare__cell">
            <RouteCard
              mode={mode}
              route={result.routes[mode]}
              selected={selected === mode}
              lang={lang}
              onSelect={() => onSelect(mode)}
              cardRef={(el) => {
                cardRefs.current[mode] = el;
              }}
              onReportFixed={onReportFixed}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
