import { useTranslation } from 'react-i18next';
import { adminApi, OPEN_STATUSES, type BarrierRow, type Summary } from './adminApi';
import AdminMap from './AdminMap';
import { ageLabel, useLoad, type Lang } from './util';

interface Props {
  summary: Summary | null;
  version: number;
  lang: Lang;
  onAssign: (b: BarrierRow) => void;
}

export default function Overview({ summary: s, version, lang, onAssign }: Props) {
  const { t } = useTranslation();
  const zone = useLoad(() => adminApi.zone(), []);
  const all = useLoad(() => adminApi.barriers('all'), [version], 30000);
  const rows = all.data?.results ?? [];
  const needs = rows.filter((b) => b.status === 'active' && !(b.work_order && OPEN_STATUSES.includes(b.work_order.status)));
  const needsReal = [...needs].sort((a, b) => Number(a.synthetic) - Number(b.synthetic) || b.severity - a.severity).slice(0, 8);

  const kpis = s
    ? [
        { key: 'pending', value: s.reports.pending, sub: t('overview.kpi.pendingToday', { n: s.reports.today }), tone: s.reports.pending ? 'warn' : '' },
        { key: 'active', value: s.barriers.active, sub: t('overview.kpi.activeSplit', { real: s.barriers.active_real, seed: s.barriers.active_synthetic }), tone: '' },
        { key: 'unassigned', value: s.barriers.unassigned, sub: t('overview.kpi.impassable', { n: s.barriers.impassable }), tone: s.barriers.unassigned ? 'bad' : 'good' },
        {
          key: 'inProgress',
          value: s.work_orders.in_progress,
          sub: t('overview.kpi.inProgressSplit', { assigned: s.work_orders.assigned + s.work_orders.open, overdue: s.work_orders.overdue }),
          tone: s.work_orders.overdue ? 'bad' : '',
        },
        { key: 'fixedWeek', value: s.fixed_last_7_days, sub: '', tone: s.fixed_last_7_days ? 'good' : '' },
        {
          key: 'medianFix',
          value:
            s.median_hours_to_close === null
              ? '–'
              : s.median_hours_to_close < 48
                ? t('overview.kpi.medianHours', { n: Math.max(0.1, s.median_hours_to_close) })
                : t('overview.kpi.medianDays', { n: Math.round(s.median_hours_to_close / 2.4) / 10 }),
          sub: s.median_hours_to_close === null ? t('overview.kpi.medianNone') : t('overview.kpi.medianSub'),
          tone: '',
        },
        { key: 'workers', value: s.workers.active, sub: '', tone: '' },
      ]
    : [];

  return (
    <section aria-labelledby="ov-title">
      <h1 id="ov-title" className="adm-h1">
        {t('overview.title')}
      </h1>
      <ul className="adm-kpis">
        {kpis.map((k) => (
          <li key={k.key} className={`adm-kpi${k.tone ? ` adm-kpi--${k.tone}` : ''}`}>
            <span className="adm-kpi__label">{t(`overview.kpi.${k.key}`)}</span>
            <strong className="adm-kpi__value">{k.value}</strong>
            {k.sub && <span className="adm-kpi__sub">{k.sub}</span>}
          </li>
        ))}
      </ul>
      <div className="adm-grid2">
        <div className="adm-card adm-card--map">
          <div className="adm-card__head">
            <h2>{t('overview.map')}</h2>
            <ul className="adm-legend">
              <li>
                <span className="dot dot--red" /> {t('overview.mapLegend.unassigned')}
              </li>
              <li>
                <span className="dot dot--amber" /> {t('overview.mapLegend.inProgress')}
              </li>
              <li>
                <span className="dot dot--green" /> {t('overview.mapLegend.fixed')}
              </li>
              <li>
                <span className="dot dot--hollow" /> {t('common.seed')}
              </li>
            </ul>
          </div>
          <AdminMap zone={zone.data} barriers={rows} lang={lang} onPick={onAssign} label={t('overview.map')} />
        </div>
        <div className="adm-card">
          <div className="adm-card__head">
            <h2>{t('overview.needsAction')}</h2>
          </div>
          <p className="adm-muted">{t('overview.needsActionHint')}</p>
          {needsReal.length === 0 ? (
            <p className="adm-empty">{all.loading ? t('common.loading') : t('overview.allClear')}</p>
          ) : (
            <ul className="adm-list">
              {needsReal.map((b) => (
                <li key={b.id} className="adm-list__row">
                  <span className={`sev sev--${b.severity}`} aria-label={t('common.severity', { n: b.severity })}>
                    {b.severity}
                  </span>
                  <span className="adm-list__main">
                    <strong>
                      #{b.id} {lang === 'hi' ? b.name_hi : b.name_en}
                    </strong>
                    {b.synthetic && (
                      <span className="tag tag--seed" title={t('common.seedHint')}>
                        {t('common.seed')}
                      </span>
                    )}
                    <span className="adm-muted">
                      {ageLabel(b.created_at, lang)} · {t('overview.reportsN', { n: b.n_reports })}
                    </span>
                  </span>
                  <button type="button" className="abtn abtn--primary abtn--sm" onClick={() => onAssign(b)}>
                    {t('overview.assign')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
