import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi, photoUrl, type ReportRow } from './adminApi';
import { mapsLink, relTime, useLoad, type Lang } from './util';

const FILTERS = ['pending', 'verified', 'rejected', 'all'] as const;

export default function Reports({ version, lang, onChanged }: { version: number; lang: Lang; onChanged: () => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('pending');
  const list = useLoad(() => adminApi.reports(filter), [filter, version], 15000);
  const rows = list.data?.results ?? [];

  return (
    <section aria-labelledby="rp-title">
      <div className="adm-head">
        <h1 id="rp-title" className="adm-h1">
          {t('reports.title')}
        </h1>
        <div className="adm-tabs" role="group">
          {FILTERS.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(`reports.filters.${f}`)}
            </button>
          ))}
        </div>
      </div>
      {list.error && <p className="adm-banner adm-banner--error">{t('common.error', { detail: list.error })}</p>}
      {rows.length === 0 ? (
        <p className="adm-empty">{list.loading ? t('common.loading') : t('reports.empty')}</p>
      ) : (
        <ul className="adm-reports">
          {rows.map((r) => (
            <ReportCard key={r.id} r={r} lang={lang} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReportCard({ r, lang, onChanged }: { r: ReportRow; lang: Lang; onChanged: () => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const img = photoUrl(r.photo_url);
  const name = (lang === 'hi' ? r.name_hi : r.name_en) ?? r.class_id;

  const decide = async (d: 'verify' | 'reject') => {
    setBusy(true);
    setErr(null);
    try {
      await adminApi.decide(r.id, d, note.trim() || undefined);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`adm-report adm-report--${r.status}`}>
      <div className="adm-report__photo">
        {img ? <img src={img} alt={t('reports.photo', { id: r.id })} loading="lazy" /> : <span className="adm-report__nophoto">{t('reports.noPhoto')}</span>}
      </div>
      <div className="adm-report__body">
        <p className="adm-report__title">
          <span className={`sev sev--${r.severity}`} aria-label={t('common.severity', { n: r.severity })}>
            {r.severity}
          </span>
          <strong>
            #{r.id} {name}
          </strong>
          <span className={`tag tag--${r.status}`}>{t(`reports.status.${r.status}`)}</span>
        </p>
        {r.kind === 'fixed' && r.target_barrier_id && <p className="adm-muted">{t('reports.kindFixed', { id: r.target_barrier_id })}</p>}
        {r.note && <p className="adm-report__note">“{r.note}”</p>}
        <p className="adm-muted">
          {r.reporter ? t('reports.reporter', { name: r.reporter.name, trust: r.reporter.trust.toFixed(2) }) : ''} · {relTime(r.created_at, lang)} ·{' '}
          <a href={mapsLink(r.lat, r.lon)} target="_blank" rel="noreferrer">
            {t('common.openMap')}
          </a>
        </p>
        <p className="adm-muted">
          {t('reports.votes', { agree: r.votes.agree, disagree: r.votes.disagree, unsure: r.votes.unsure })}
          {typeof r.model_prescreen_score === 'number' && ` · ${t('reports.prescreen', { score: r.model_prescreen_score.toFixed(2) })}`}
        </p>
        {r.status === 'pending' ? (
          <div className="adm-report__actions">
            <label className="sr-only" htmlFor={`note-${r.id}`}>
              {t('reports.decisionNote')}
            </label>
            <input id={`note-${r.id}`} type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('reports.decisionNote')} maxLength={500} />
            <button type="button" className="abtn abtn--good" disabled={busy} onClick={() => void decide('verify')}>
              ✓ {t('reports.verify')}
            </button>
            <button type="button" className="abtn abtn--bad" disabled={busy} onClick={() => void decide('reject')}>
              ✕ {t('reports.reject')}
            </button>
          </div>
        ) : (
          <p className="adm-muted">
            {t('reports.resolved', { status: t(`reports.status.${r.status}`), time: relTime(r.resolved_at, lang) })}
            {r.barrier_id ? ` · ${t('reports.linked', { id: r.barrier_id })}` : ''}
            {r.sources_note?.startsWith('authority') ? ` · ${t('reports.authority')}` : ''}
          </p>
        )}
        {err && (
          <p className="adm-err" role="alert">
            {err}
          </p>
        )}
      </div>
    </li>
  );
}
