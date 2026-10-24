// Move mode, after a search: two cards side by side, "Standard route" (what a
// normal map suggests) and "SAMAAN route" (recommended). Each shows minutes, km,
// a confidence ring, barriers and how much of it was checked. Tapping a card
// previews it on the map (the other is dimmed); Start begins navigation.
import { useId, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedName, photoUrl, ROUTE_MODES, type RouteBarrier, type RouteMode, type RouteResponse, type RouteResult } from '../api';
import type { Lang } from '../i18n';
import ConfidenceRing from './ConfidenceRing';
import StepGlyph from './StepGlyph';
import { stepInstruction } from './useAnnouncer';

interface RouteChoiceProps {
  result: RouteResponse;
  selected: RouteMode | null;
  lang: Lang;
  loading: boolean;
  onSelect: (mode: RouteMode) => void;
  onStart: (mode: RouteMode) => void;
  onEdit: () => void;
  onReportFixed: (barrier: RouteBarrier) => void;
  headingRef: RefObject<HTMLHeadingElement>;
}

function pct(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)));
}

function km(m: number, lang: Lang): string {
  return new Intl.NumberFormat(lang, { maximumFractionDigits: m < 10000 ? 1 : 0 }).format(m / 1000);
}

function RouteCard({ mode, route, selected, lang, onSelect }: { mode: RouteMode; route: RouteResult | null; selected: boolean; lang: Lang; onSelect: () => void }) {
  const { t } = useTranslation();
  const title = t(`route.mode.${mode}.title`);
  const summary = route
    ? t('route.summary', {
        title,
        length: Math.round(route.length_m),
        minutes: Math.round(route.eta_min),
        verified: pct(route.verified_pct),
        barriers: t('route.barriers', { count: route.n_barriers }),
        confidence: t('confidence.summary', { pct: Math.round((route.confidence?.score ?? 0) * 100), label: t(`confidence.${route.confidence?.label ?? 'low'}`) }),
      })
    : t('route.summaryNone', { title });
  return (
    <button
      type="button"
      className={`rchoice rchoice--${mode}${selected ? ' rchoice--selected' : ''}`}
      aria-pressed={selected}
      aria-label={summary}
      onClick={onSelect}
      disabled={!route}
    >
      <span className="rchoice__head" aria-hidden="true">
        <span className="rchoice__title">{title}</span>
        {mode === 'samaan' ? <span className="badge badge--recommended">{t('route.recommended')}</span> : <span className="rchoice__explain">{t('route.mode.standard.short')}</span>}
      </span>
      {route ? (
        <span className="rchoice__body" aria-hidden="true">
          <span className="rchoice__nums">
            <span className="rchoice__big">
              {Math.round(route.eta_min)}
              <span className="rchoice__unit"> {t('units.min')}</span>
            </span>
            <span className="rchoice__km">
              {km(route.length_m, lang)} {t('units.km')}
            </span>
          </span>
          <ConfidenceRing confidence={route.confidence} size={60} />
          <span className="rchoice__line">
            {t('route.barriers', { count: route.n_barriers })}
            {route.n_barriers_impassable > 0 && (
              <span className="rchoice__imp">
                {' '}
                ({t('route.impassableShort', { count: route.n_barriers_impassable })})
              </span>
            )}
          </span>
          <span className="rchoice__line rchoice__line--muted">
            {t('route.checkedLine', { pct: pct(route.verified_pct), segments: route.segments_no_recent_imagery ?? 0 })}
          </span>
          {route.synthetic && <span className="badge badge--synthetic badge--tiny">{t('badge.synthetic')}</span>}
          {selected && <span className="rchoice__check">✓ {t('route.selectedShort')}</span>}
        </span>
      ) : (
        <span className="rcard__none" aria-hidden="true">
          {t('route.noRoute')}
        </span>
      )}
    </button>
  );
}

function BarrierRow({ barrier, lang, onReportFixed }: { barrier: RouteBarrier; lang: Lang; onReportFixed: (b: RouteBarrier) => void }) {
  const { t } = useTranslation();
  const name = localizedName(barrier, lang);
  const photo = barrier.photo_urls?.[0];
  const p = typeof barrier.p_present === 'number' ? barrier.p_present : 1;
  return (
    <li className={`rb${barrier.impassable_for_profile ? ' rb--impassable' : ''}`} lang={lang}>
      {photo && <img className="rb__photo" src={photoUrl(photo)} alt={t('route.photoAlt', { name })} loading="lazy" decoding="async" width={56} height={56} />}
      <div className="rb__text">
        <span className="rb__name">
          <span className={`sev sev--${barrier.severity}`} aria-hidden="true">
            {barrier.severity}
          </span>{' '}
          {name}
        </span>
        <span className="rb__meta">
          {t(`barrierClass.${barrier.class}`, { defaultValue: String(barrier.class) })} · {t('severity.label')} {barrier.severity} · {barrier.permanent ? t('popup.permanent') : t('popup.temporary')}
          {p < 1 ? ` · ${t('route.likelyPresent', { pct: Math.round(p * 100) })}` : ''}
        </span>
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

export default function RouteChoice({ result, selected, lang, loading, onSelect, onStart, onEdit, onReportFixed, headingRef }: RouteChoiceProps) {
  const { t } = useTranslation();
  const id = useId();
  const label = lang === 'hi' ? result.label_hi || result.label_en : result.label_en || result.label_hi;
  const route = selected ? result.routes[selected] : null;
  const unknownLength = route ? Math.round(route.unknown_stretches.reduce((acc, s) => acc + s.length_m, 0)) : 0;
  const canStart = Boolean(selected && route);

  return (
    <section className="sheet-choice" aria-labelledby={`${id}-title`}>
      <div className="grabber" aria-hidden="true" />
      <div className="sheet-choice__head">
        <h2 id={`${id}-title`} className="sheet-choice__title" ref={headingRef} tabIndex={-1}>
          {label ?? t('route.compareTitle')}
        </h2>
        <button type="button" className="btn btn--small btn--ghost" onClick={onEdit}>
          {t('route.edit')}
        </button>
      </div>
      <p className="sheet-choice__meta">
        {t('route.departureHour', { hour: String(result.departure_hour).padStart(2, '0') })} · {t(`route.profile.${result.profile}`, { defaultValue: result.profile })} ·{' '}
        {t(`route.risk.${result.risk}`)}
        {result.synthetic_overlay && <span className="badge badge--synthetic badge--tiny"> {t('badge.synthetic')}</span>}
      </p>
      {typeof result.origin.snap_distance_m === 'number' && result.origin.snap_distance_m >= 1 && (
        <p className="place__hint">{t('route.snapped', { field: t('route.origin'), m: Math.round(result.origin.snap_distance_m) })}</p>
      )}
      {typeof result.destination.snap_distance_m === 'number' && result.destination.snap_distance_m >= 1 && (
        <p className="place__hint">{t('route.snapped', { field: t('route.destination'), m: Math.round(result.destination.snap_distance_m) })}</p>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {selected ? t('route.mapSelected', { title: t(`route.mode.${selected}.title`) }) : ''}
        {loading ? ` ${t('route.loading')}` : ''}
      </p>

      <div className="rchoices" role="group" aria-label={t('route.cardsLabel')}>
        {ROUTE_MODES.map((mode) => (
          <RouteCard key={mode} mode={mode} route={result.routes[mode]} selected={selected === mode} lang={lang} onSelect={() => onSelect(mode)} />
        ))}
      </div>

      <button type="button" className="btn btn--primary btn--big sheet-choice__start" onClick={() => selected && onStart(selected)} disabled={!canStart}>
        {t('nav.start')}
      </button>

      {route && (
        <details className="rdetails">
          <summary className="rdetails__summary">{t('route.details')}</summary>
          <p className="rcard__note">
            {route.n_unknown_stretches > 0 ? t('route.unknownStretches', { count: route.n_unknown_stretches, length: unknownLength }) : t('route.noUnknown')}
            {' · '}
            {t('route.segmentsNoImagery', { count: route.segments_no_recent_imagery ?? 0, total: route.segments_total ?? 0 })}
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
          {route.steps && route.steps.length > 0 && (
            <ol className="steps">
              {route.steps.map((s) => (
                <li key={s.index} className="steps__row">
                  <StepGlyph type={s.type} size={28} className="steps__glyph" />
                  <span className="steps__text">
                    <span>{stepInstruction(s, lang)}</span>
                    <span className="steps__meta">
                      {Math.round(s.distance_m)} {t('units.m')}
                      {s.warnings.length > 0 ? ` · ${s.warnings.map((w) => (lang === 'hi' ? w.name_hi || w.name_en : w.name_en)).join(', ')}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </details>
      )}
    </section>
  );
}
