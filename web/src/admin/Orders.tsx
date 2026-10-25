import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi, NEXT, type OrderStatus, type WorkOrder, type Worker } from './adminApi';
import { fmtDate, mapsLink, relTime, useLoad, type Lang } from './util';

const COLUMNS: OrderStatus[] = ['open', 'assigned', 'in_progress'];

export default function Orders({ version, lang, onChanged }: { version: number; lang: Lang; onChanged: () => void }) {
  const { t } = useTranslation();
  const open = useLoad(() => adminApi.orders('open_all'), [version], 15000);
  const all = useLoad(() => adminApi.orders('all'), [version]);
  const workers = useLoad(() => adminApi.workers(), [version]);
  const rows = open.data?.results ?? [];
  const closed = (all.data?.results ?? []).filter((o) => !COLUMNS.includes(o.status)).slice(0, 12);
  const activeWorkers = (workers.data?.results ?? []).filter((w) => w.active);

  return (
    <section aria-labelledby="wo-title">
      <h1 id="wo-title" className="adm-h1">
        {t('orders.title')}
      </h1>
      {open.error && <p className="adm-banner adm-banner--error">{t('common.error', { detail: open.error })}</p>}
      <div className="adm-board">
        {COLUMNS.map((col) => {
          const items = rows.filter((o) => o.status === col);
          return (
            <section key={col} className="adm-col" aria-labelledby={`col-${col}`}>
              <h2 id={`col-${col}`}>
                {t(`orders.columns.${col}`)} <span className="adm-count">{items.length}</span>
              </h2>
              {items.length === 0 ? (
                <p className="adm-empty adm-empty--sm">{t('orders.empty')}</p>
              ) : (
                <ul>
                  {items.map((o) => (
                    <OrderCard key={o.id} o={o} lang={lang} workers={activeWorkers} onChanged={onChanged} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <h2 className="adm-h2">{t('orders.closed')}</h2>
      {closed.length === 0 ? (
        <p className="adm-empty">{t('orders.empty')}</p>
      ) : (
        <ul className="adm-closed">
          {closed.map((o) => (
            <li key={o.id}>
              <span className={`tag tag--${o.status}`}>{t(`orders.status.${o.status}`)}</span>
              <strong>
                #{o.id} {o.barrier ? (lang === 'hi' ? o.barrier.name_hi : o.barrier.name_en) : `#${o.barrier_id}`}
              </strong>
              <span className="adm-muted">
                {o.worker_name ?? t('orders.noWorker')} · {relTime(o.completed_at ?? o.updated_at, lang)}
                {o.resolution_note ? ` · “${o.resolution_note}”` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OrderCard({ o, lang, workers, onChanged }: { o: WorkOrder; lang: Lang; workers: Worker[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState<OrderStatus | null>(null);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const b = o.barrier;

  const patch = async (p: Parameters<typeof adminApi.updateOrder>[1]) => {
    setBusy(true);
    setErr(null);
    try {
      await adminApi.updateOrder(o.id, p);
      setConfirm(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const nextActions = NEXT[o.status].filter((s) => !(s === 'assigned' && o.status === 'open'));

  return (
    <li className={`adm-order adm-order--${o.priority}${o.overdue ? ' adm-order--overdue' : ''}`}>
      <p className="adm-order__title">
        <span className={`tag tag--prio-${o.priority}`}>{t(`priority.${o.priority}`)}</span>
        <strong>
          #{o.id} {b ? (lang === 'hi' ? b.name_hi : b.name_en) : `#${o.barrier_id}`}
        </strong>
      </p>
      <p className="adm-muted">
        {b && (
          <>
            {t('common.severity', { n: b.severity })} ·{' '}
            <a href={mapsLink(b.lat, b.lon)} target="_blank" rel="noreferrer">
              {t('common.openMap')}
            </a>
            {b.synthetic ? ` · ${t('common.seed')}` : ''}
          </>
        )}
      </p>
      {o.note && <p className="adm-order__note">{o.note}</p>}
      <p className="adm-muted">
        {o.due_date && <span className={o.overdue ? 'adm-overdue' : ''}>{o.overdue ? `${t('orders.overdue')} · ` : ''}{t('orders.due', { date: fmtDate(o.due_date, lang) })}</span>}
      </p>
      <label className="adm-field adm-field--inline">
        <span>{t('orders.reassign')}</span>
        <select value={o.worker_id ?? ''} disabled={busy} onChange={(e) => e.target.value && void patch({ worker_id: Number(e.target.value) })}>
          <option value="">{t('orders.noWorker')}</option>
          {workers.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.open_jobs})
            </option>
          ))}
        </select>
      </label>

      {confirm ? (
        <div className="adm-confirm">
          {confirm === 'done' && <p className="adm-muted">{t('orders.fixedEffect')}</p>}
          <label className="adm-field">
            <span>{t('orders.resolution')}</span>
            <input type="text" value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder={t('orders.resolutionPlaceholder')} maxLength={500} autoFocus />
          </label>
          <div className="adm-btnrow">
            <button type="button" className="abtn abtn--ghost abtn--sm" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={`abtn abtn--sm ${confirm === 'done' ? 'abtn--good' : 'abtn--bad'}`}
              disabled={busy}
              onClick={() => void patch({ status: confirm, resolution_note: resolution.trim() || undefined })}
            >
              {t('orders.confirm')}: {t(`orders.action.${confirm}`)}
            </button>
          </div>
        </div>
      ) : (
        <div className="adm-btnrow">
          {nextActions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy || ((s === 'in_progress' || s === 'assigned') && !o.worker_id)}
              className={`abtn abtn--sm ${s === 'done' ? 'abtn--good' : s === 'in_progress' || s === 'assigned' ? 'abtn--primary' : 'abtn--ghost'}`}
              onClick={() => (s === 'done' || s === 'cant_fix' || s === 'cancelled' ? setConfirm(s) : void patch({ status: s }))}
            >
              {t(`orders.action.${s}`)}
            </button>
          ))}
        </div>
      )}
      {err && (
        <p className="adm-err" role="alert">
          {err}
        </p>
      )}
      <button type="button" className="adm-link" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
        {t('orders.history')} ({o.history.length})
      </button>
      {showHistory && (
        <ol className="adm-history">
          {o.history.map((h, i) => (
            <li key={i}>
              {t(`orders.status.${h.status}`)} · {relTime(h.at, lang)}
              {h.by ? ` · ${t('common.by', { name: h.by })}` : ''}
              {h.note ? ` · “${h.note}”` : ''}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
