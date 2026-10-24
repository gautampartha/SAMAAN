// Statistics: 2x2 cards computed client-side from the layers already loaded
// (/layers/footpaths, /layers/barriers, /layers/wheels) plus GET /reports?status=pending,
// and the confidence of the last route started on this phone.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isWheelsEdgeFeature, reportApi, type FootpathState, type LayerData } from '../api';
import type { Lang } from '../i18n';
import { useLastConfidence } from '../mode';
import ConfidenceRing from './ConfidenceRing';

interface StatsPageProps {
  data: LayerData;
  lang: Lang;
  loading: boolean;
  onRefresh: () => void;
}

/** Three tiny bars (CSS) with the share of each value; the text next to it repeats the numbers. */
function MiniBars({ parts }: { parts: { key: string; value: number; label: string }[] }) {
  const max = Math.max(1, ...parts.map((p) => p.value));
  return (
    <span className="minibars" aria-hidden="true">
      {parts.map((p) => (
        <span key={p.key} className={`minibars__bar minibars__bar--${p.key}`} style={{ height: `${Math.max(8, Math.round((p.value / max) * 100))}%` }} />
      ))}
    </span>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - (v / max) * 26}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function StatsPage({ data, lang, loading, onRefresh }: StatsPageProps) {
  const { t } = useTranslation();
  const last = useLastConfidence();
  const [pending, setPending] = useState<number | null>(null);
  const [pendingError, setPendingError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setPendingError(false);
    reportApi
      .list({ status: 'pending', limit: 200 }, ac.signal)
      .then((res) => {
        if (!ac.signal.aborted) setPending(typeof res.count === 'number' ? res.count : res.results.length);
      })
      .catch(() => {
        if (!ac.signal.aborted) setPendingError(true);
      });
    return () => ac.abort();
  }, [nonce]);

  const footpaths = useMemo(() => {
    const byState: Record<FootpathState, number> = { clear: 0, blocked: 0, unknown: 0 };
    for (const f of data.footpaths?.features ?? []) {
      const s = f.properties.state;
      byState[s in byState ? s : 'unknown'] += f.properties.length_m || 0;
    }
    const checked = byState.clear + byState.blocked;
    const total = checked + byState.unknown;
    return { byState, checkedKm: checked / 1000, totalKm: total / 1000, pct: total > 0 ? Math.round((checked / total) * 100) : 0 };
  }, [data.footpaths]);

  const barriers = useMemo(() => {
    const feats = data.barriers?.features ?? [];
    const active = feats.filter((f) => f.properties.status === 'active');
    const bySeverity = [1, 2, 3, 4, 5].map((s) => active.filter((f) => f.properties.severity === s).length);
    return { active: active.length, total: feats.length, bySeverity, suspected: feats.filter((f) => f.properties.status === 'suspected').length };
  }, [data.barriers]);

  const wheels = useMemo(() => {
    const edges = (data.wheels?.features ?? []).filter(isWheelsEdgeFeature);
    const verified = edges.filter((f) => f.properties.verified_by_wheels).length;
    return { verified, traversed: edges.length };
  }, [data.wheels]);

  const fmt = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });

  return (
    <div className="page stats">
      <div className="page__head">
        <h2 className="page__title">{t('stats.title')}</h2>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            onRefresh();
            setNonce((n) => n + 1);
          }}
          aria-busy={loading}
        >
          {t('stats.refresh')}
        </button>
      </div>
      <p className="panel__hint">{t('stats.intro')}</p>

      <div className="statgrid">
        <article className="statcard" aria-label={t('stats.footpathsSr', { km: fmt.format(footpaths.checkedKm), total: fmt.format(footpaths.totalKm), pct: footpaths.pct })}>
          <p className="statcard__num" aria-hidden="true">
            {fmt.format(footpaths.checkedKm)}
            <span className="statcard__unit"> {t('units.km')}</span>
          </p>
          <p className="statcard__label" aria-hidden="true">
            {t('stats.footpaths')}
          </p>
          <p className="statcard__sub" aria-hidden="true">
            {t('stats.footpathsSub', { pct: footpaths.pct, total: fmt.format(footpaths.totalKm) })}
          </p>
          <MiniBars
            parts={[
              { key: 'clear', value: footpaths.byState.clear, label: t('state.clear') },
              { key: 'blocked', value: footpaths.byState.blocked, label: t('state.blocked') },
              { key: 'unknown', value: footpaths.byState.unknown, label: t('state.unknown') },
            ]}
          />
        </article>

        <article className="statcard" aria-label={t('stats.barriersSr', { count: barriers.active, total: barriers.total })}>
          <p className="statcard__num" aria-hidden="true">
            {barriers.active}
          </p>
          <p className="statcard__label" aria-hidden="true">
            {t('stats.barriers')}
          </p>
          <p className="statcard__sub" aria-hidden="true">
            {t('stats.barriersSub', { total: barriers.total, suspected: barriers.suspected })}
          </p>
          <Sparkline values={barriers.bySeverity} />
        </article>

        <article className="statcard" aria-label={pending === null ? t('stats.reportsUnknown') : t('stats.reportsSr', { count: pending })}>
          <p className="statcard__num" aria-hidden="true">
            {pending === null ? '—' : pending}
          </p>
          <p className="statcard__label" aria-hidden="true">
            {t('stats.reports')}
          </p>
          <p className="statcard__sub" aria-hidden="true">
            {pendingError ? t('stats.reportsError') : t('stats.reportsSub')}
          </p>
        </article>

        <article className="statcard" aria-label={t('stats.wheelsSr', { count: wheels.verified, total: wheels.traversed })}>
          <p className="statcard__num" aria-hidden="true">
            {wheels.verified}
          </p>
          <p className="statcard__label" aria-hidden="true">
            {t('stats.wheels')}
          </p>
          <p className="statcard__sub" aria-hidden="true">
            {t('stats.wheelsSub', { total: wheels.traversed })}
          </p>
          <MiniBars
            parts={[
              { key: 'clear', value: wheels.verified, label: t('wheels.verifiedTitle') },
              { key: 'unknown', value: Math.max(0, wheels.traversed - wheels.verified), label: t('wheels.traversedTitle') },
            ]}
          />
        </article>
      </div>

      <article className="statcard statcard--wide">
        <div className="statcard__row">
          <ConfidenceRing confidence={last ? { score: last.score, label: last.label, factors: { verified_pct: last.verified_pct, median_image_age_days: null, barrier_confidence: null, unknown_pct: 0, fresh_segments_pct: 0 } } : null} size={72} />
          <div>
            <p className="statcard__label">{t('stats.lastConfidence')}</p>
            <p className="statcard__sub">
              {last
                ? t('stats.lastConfidenceSub', {
                    route: t(`route.mode.${last.mode}.title`),
                    pct: Math.round(last.verified_pct),
                    when: new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(last.at)),
                  })
                : t('stats.noTrip')}
            </p>
          </div>
        </div>
      </article>
    </div>
  );
}
