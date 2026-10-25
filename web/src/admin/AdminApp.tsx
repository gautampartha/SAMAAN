// SAMAAN Authority Console: the web app the campus estate office / municipality uses to review
// citizen reports, turn barriers into work orders for field workers, and close them when fixed.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { adminApi, getToken, setToken, type BarrierRow } from './adminApi';
import { toLang, useLoad } from './util';
import Overview from './Overview';
import Reports from './Reports';
import Barriers from './Barriers';
import Orders from './Orders';
import Workers from './Workers';
import AssignDialog from './AssignDialog';

type Section = 'overview' | 'reports' | 'barriers' | 'orders' | 'workers';
const SECTIONS: Section[] = ['overview', 'reports', 'barriers', 'orders', 'workers'];

function sectionFromHash(): Section {
  const h = location.hash.replace(/^#\/?/, '') as Section;
  return SECTIONS.includes(h) ? h : 'overview';
}

export default function AdminApp() {
  const { t, i18n } = useTranslation();
  const lang = toLang(i18n.language);
  const [section, setSection] = useState<Section>(sectionFromHash);
  const [version, setVersion] = useState(0); // bump after any change so every view reloads
  const [assignFor, setAssignFor] = useState<BarrierRow | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [hasToken, setHasToken] = useState(Boolean(getToken()));
  const summary = useLoad(() => adminApi.summary(), [version, hasToken], 20000);

  useEffect(() => {
    const on = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    document.title = `${t(`nav.${section}`)} · ${t('app.brand')} ${t('app.title')}`;
  }, [section, t, lang]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const s = summary.data;
  const needsToken = summary.error?.startsWith('401');
  const zoneName = s?.zone ? (lang === 'hi' && s.zone.hi) || s.zone.en : '';
  const badge: Partial<Record<Section, number>> = s
    ? { reports: s.reports.pending, barriers: s.barriers.unassigned, orders: s.work_orders.open + s.work_orders.assigned + s.work_orders.in_progress }
    : {};

  return (
    <div className="adm">
      <a className="adm-skip" href="#adm-main">
        Skip to content
      </a>
      <header className="adm-top">
        <div className="adm-brand">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" width="40" height="40" />
          <div>
            <p className="adm-brand__name">
              {t('app.brand')} <span>{t('app.title')}</span>
            </p>
            <p className="adm-brand__sub">{zoneName ? `${t('app.zone')}: ${zoneName}` : t('app.sub')}</p>
          </div>
        </div>
        <div className="adm-top__right">
          <span className="adm-updated" aria-live="polite">
            {summary.loading ? t('common.loading') : t('common.updated', { time: new Date().toLocaleTimeString(lang === 'hi' ? 'hi-IN' : 'en-IN', { hour: '2-digit', minute: '2-digit' }) })}
          </span>
          <button type="button" className="abtn abtn--ghost" onClick={changed}>
            ↻ {t('common.refresh')}
          </button>
          <div className="adm-seg" role="group" aria-label={t('lang.label')}>
            {(['en', 'hi'] as const).map((l) => (
              <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => void i18n.changeLanguage(l)}>
                {t(`lang.${l}`)}
              </button>
            ))}
          </div>
          {hasToken && (
            <button
              type="button"
              className="abtn abtn--ghost"
              onClick={() => {
                setToken('');
                setHasToken(false);
              }}
            >
              {t('auth.signOut')}
            </button>
          )}
        </div>
      </header>

      {s?.auth === 'open' && <p className="adm-banner adm-banner--warn">{t('auth.open')}</p>}
      {needsToken && (
        <form
          className="adm-banner adm-banner--token"
          onSubmit={(e) => {
            e.preventDefault();
            setToken(tokenInput.trim());
            setHasToken(Boolean(tokenInput.trim()));
            setTokenInput('');
          }}
        >
          <label>
            {t('auth.needed')}{' '}
            <input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder={t('auth.tokenPrompt')} autoComplete="current-password" />
          </label>
          <button type="submit" className="abtn abtn--primary">
            {t('auth.signIn')}
          </button>
        </form>
      )}
      {summary.error && !needsToken && (
        <p className="adm-banner adm-banner--error" role="alert">
          {t('common.error', { detail: summary.error })}
        </p>
      )}

      <div className="adm-body">
        <nav className="adm-nav" aria-label={t('nav.label')}>
          {SECTIONS.map((sec) => (
            <a key={sec} href={`#/${sec}`} aria-current={section === sec ? 'page' : undefined} className="adm-nav__item">
              <span>{t(`nav.${sec}`)}</span>
              {badge[sec] ? <span className="adm-nav__badge">{badge[sec]}</span> : null}
            </a>
          ))}
        </nav>
        <main id="adm-main" className="adm-main" tabIndex={-1}>
          {section === 'overview' && <Overview summary={s} version={version} lang={lang} onAssign={setAssignFor} />}
          {section === 'reports' && <Reports version={version} lang={lang} onChanged={changed} />}
          {section === 'barriers' && <Barriers version={version} lang={lang} onAssign={setAssignFor} />}
          {section === 'orders' && <Orders version={version} lang={lang} onChanged={changed} />}
          {section === 'workers' && <Workers version={version} onChanged={changed} />}
        </main>
      </div>

      {assignFor && (
        <AssignDialog
          barrier={assignFor}
          lang={lang}
          onClose={() => setAssignFor(null)}
          onCreated={() => {
            setAssignFor(null);
            changed();
          }}
        />
      )}
    </div>
  );
}
