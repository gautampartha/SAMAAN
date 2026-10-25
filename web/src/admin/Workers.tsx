import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi } from './adminApi';
import { useLoad } from './util';

export default function Workers({ version, onChanged }: { version: number; onChanged: () => void }) {
  const { t } = useTranslation();
  const list = useLoad(() => adminApi.workers(), [version]);
  const [form, setForm] = useState({ name: '', phone: '', department: '', area: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const w = await adminApi.addWorker({
        name: form.name.trim(),
        phone: form.phone.trim() || undefined,
        department: form.department.trim() || undefined,
        area: form.area.trim() || undefined,
      });
      setMsg(t('workers.added', { name: w.name }));
      setForm({ name: '', phone: '', department: '', area: '' });
      onChanged();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: number, active: boolean) => {
    try {
      await adminApi.updateWorker(id, { active });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const rows = list.data?.results ?? [];
  return (
    <section aria-labelledby="wk-title">
      <h1 id="wk-title" className="adm-h1">
        {t('workers.title')}
      </h1>
      <form className="adm-card adm-workerform" onSubmit={(e) => void add(e)}>
        <h2>{t('workers.add')}</h2>
        <div className="adm-row4">
          <label className="adm-field">
            <span>{t('workers.name')} *</span>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} />
          </label>
          <label className="adm-field">
            <span>{t('workers.phone')}</span>
            <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} />
          </label>
          <label className="adm-field">
            <span>{t('workers.department')}</span>
            <input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder={t('workers.departmentPlaceholder')} maxLength={80} />
          </label>
          <label className="adm-field">
            <span>{t('workers.area')}</span>
            <input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} placeholder={t('workers.areaPlaceholder')} maxLength={80} />
          </label>
        </div>
        <div className="adm-btnrow">
          <button type="submit" className="abtn abtn--primary" disabled={busy || !form.name.trim()}>
            + {t('workers.add')}
          </button>
          <span className="adm-muted" role="status" aria-live="polite">
            {msg}
          </span>
        </div>
        {err && (
          <p className="adm-err" role="alert">
            {err}
          </p>
        )}
      </form>
      {rows.length === 0 ? (
        <p className="adm-empty">{list.loading ? t('common.loading') : t('workers.empty')}</p>
      ) : (
        <div className="adm-tablewrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">{t('workers.name')}</th>
                <th scope="col">{t('workers.phone')}</th>
                <th scope="col">{t('workers.department')}</th>
                <th scope="col">{t('workers.area')}</th>
                <th scope="col">{t('workers.openJobs')}</th>
                <th scope="col">{t('workers.active')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className={w.active ? '' : 'adm-row--off'}>
                  <td>
                    <strong>{w.name}</strong>
                  </td>
                  <td>{w.phone ? <a href={`tel:${w.phone}`}>{w.phone}</a> : '–'}</td>
                  <td>{w.department ?? '–'}</td>
                  <td>{w.area ?? '–'}</td>
                  <td>{w.open_jobs}</td>
                  <td>
                    <button type="button" className="abtn abtn--ghost abtn--sm" onClick={() => void toggle(w.id, !w.active)}>
                      {w.active ? `${t('workers.active')} · ${t('workers.deactivate')}` : `${t('workers.inactive')} · ${t('workers.activate')}`}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
