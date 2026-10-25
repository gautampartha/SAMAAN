import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi, OPEN_STATUSES, type BarrierRow } from './adminApi';
import { ageLabel, mapsLink, relTime, useLoad, type Lang } from './util';

const FILTERS = ['active', 'fixed', 'all'] as const;

export default function Barriers({ version, lang, onAssign }: { version: number; lang: Lang; onAssign: (b: BarrierRow) => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('active');
  const [showSeed, setShowSeed] = useState(false);
  const list = useLoad(() => adminApi.barriers(filter), [filter, version], 30000);
  const rows = (list.data?.results ?? []).filter((b) => showSeed || !b.synthetic);

  return (
    <section aria-labelledby="br-title">
      <div className="adm-head">
        <h1 id="br-title" className="adm-h1">
          {t('barriers.title')}
        </h1>
        <div className="adm-tabs" role="group">
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(`barriers.filters.${f}`)}
            </button>
          ))}
        </div>
        <label className="adm-check">
          <input type="checkbox" checked={showSeed} onChange={(e) => setShowSeed(e.target.checked)} /> {t('barriers.showSeed')}
        </label>
      </div>
      {list.error && <p className="adm-banner adm-banner--error">{t('common.error', { detail: list.error })}</p>}
      {rows.length === 0 ? (
        <p className="adm-empty">{list.loading ? t('common.loading') : t('barriers.empty')}</p>
      ) : (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                {(['id', 'type', 'severity', 'age', 'reports', 'source', 'job', 'action'] as const).map((c) => (
                  <th key={c} scope="col">
                    {t(`barriers.cols.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const wo = b.work_order;
                const open = wo && OPEN_STATUSES.includes(wo.status);
                return (
                  <tr key={b.id}>
                    <td>#{b.id}</td>
                    <td>
                      <a href={mapsLink(b.lat, b.lon)} target="_blank" rel="noreferrer">
                        {lang === 'hi' ? b.name_hi : b.name_en}
                      </a>
                      {b.note && <div className="adm-muted adm-clip">{b.note}</div>}
                    </td>
                    <td>
                      <span className={`sev sev--${b.severity}`} aria-label={t('common.severity', { n: b.severity })}>
                        {b.severity}
                      </span>
                    </td>
                    <td>{b.status === 'fixed' ? t('barriers.fixedOn', { time: relTime(b.fixed_at, lang) }) : ageLabel(b.created_at, lang)}</td>
                    <td>{b.n_reports}</td>
                    <td>
                      {b.synthetic ? (
                        <span className="tag tag--seed" title={t('common.seedHint')}>
                          {t('common.seed')}
                        </span>
                      ) : (
                        <span className="tag tag--real">{t('common.real')}</span>
                      )}
                    </td>
                    <td>
                      {wo ? (
                        <span className={`tag tag--${wo.status}`}>
                          #{wo.id} {t(`orders.status.${wo.status}`)}
                          {wo.worker_name ? ` · ${wo.worker_name}` : ''}
                        </span>
                      ) : (
                        <span className="adm-muted">{t('barriers.noJob')}</span>
                      )}
                    </td>
                    <td>
                      {b.status === 'active' && !open ? (
                        <button type="button" className="abtn abtn--primary abtn--sm" onClick={() => onAssign(b)}>
                          {t('barriers.assign')}
                        </button>
                      ) : open ? (
                        <a className="abtn abtn--ghost abtn--sm" href="#/orders">
                          {t('barriers.viewJob')}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
