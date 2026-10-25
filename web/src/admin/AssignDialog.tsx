import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi, PRIORITIES, type BarrierRow, type Priority } from './adminApi';
import { useLoad, type Lang } from './util';

const BY_KEY = 'samaan.admin.by';

export default function AssignDialog({ barrier, lang, onClose, onCreated }: { barrier: BarrierRow; lang: Lang; onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const workers = useLoad(() => adminApi.workers(), []);
  const active = (workers.data?.results ?? []).filter((w) => w.active);
  const [workerId, setWorkerId] = useState<string>('');
  const [priority, setPriority] = useState<Priority>(barrier.severity >= 5 ? 'urgent' : barrier.severity >= 4 ? 'high' : 'normal');
  const [due, setDue] = useState(() => new Date(Date.now() + (barrier.severity >= 4 ? 2 : 7) * 86400000).toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [by, setBy] = useState(() => {
    try {
      return localStorage.getItem(BY_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    if (!workerId && active.length) {
      // least-loaded active worker first
      const best = [...active].sort((a, b) => a.open_jobs - b.open_jobs)[0];
      setWorkerId(String(best.id));
    }
  }, [active, workerId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      try {
        localStorage.setItem(BY_KEY, by);
      } catch {
        /* ignore */
      }
      await adminApi.createOrder({
        barrier_id: barrier.id,
        worker_id: workerId ? Number(workerId) : null,
        priority,
        due_date: due || null,
        note: note.trim() || undefined,
        created_by: by.trim() || undefined,
      });
      onCreated();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="adm-dialog" aria-labelledby="as-title" onClose={onClose} onCancel={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="as-title">{t('assign.title')}</h2>
        <p className="adm-muted">
          {t('assign.barrier', { id: barrier.id, name: lang === 'hi' ? barrier.name_hi : barrier.name_en })} · {t('common.severity', { n: barrier.severity })}
          {barrier.synthetic ? ` · ${t('common.seed')}` : ''}
        </p>
        <label className="adm-field">
          <span>{t('assign.worker')}</span>
          <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
            <option value="">{t('assign.noWorker')}</option>
            {active.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.department ? ` · ${w.department}` : ''} ({w.open_jobs})
              </option>
            ))}
          </select>
          {workers.data && active.length === 0 && <small className="adm-muted">{t('assign.noWorkers')}</small>}
        </label>
        <div className="adm-row2">
          <label className="adm-field">
            <span>{t('assign.priority')}</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="adm-field">
            <span>{t('assign.due')}</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <label className="adm-field">
          <span>{t('assign.note')}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} placeholder={t('assign.notePlaceholder')} />
        </label>
        <label className="adm-field">
          <span>{t('assign.by')}</span>
          <input type="text" value={by} onChange={(e) => setBy(e.target.value)} maxLength={80} autoComplete="name" />
        </label>
        {err && (
          <p className="adm-err" role="alert">
            {err}
          </p>
        )}
        <div className="adm-dialog__actions">
          <button type="button" className="abtn abtn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="abtn abtn--primary" disabled={busy} aria-busy={busy}>
            {t('assign.create')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
