// Demo page (More -> Demo): honest counters from GET /demo/status (real vs
// synthetic, coverage, reports, rides), one-tap demo trips in each mode, the
// demo wheelchair ride replay, and "Reset demo data" (POST /demo/reset). Also
// the brief for collecting real campus photos with the Capture page.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { demoApi, localized, rideApi, type AppMode, type DemoCounts } from '../api';
import type { Lang } from '../i18n';
import { Icon } from '../icons';
import { APP_MODES } from '../mode';
import { hrefFor } from '../router';
import { useUser } from '../user';

interface DemoPageProps {
  lang: Lang;
  onRunDemo: (mode: AppMode) => void;
  /** Layers / routes changed on the server (after a reset or a replay). */
  onChanged: () => void;
}

type Busy = 'status' | 'reset' | 'ride' | null;

export default function DemoPage({ lang, onRunDemo, onChanged }: DemoPageProps) {
  const { t } = useTranslation();
  const user = useUser();
  const [status, setStatus] = useState<DemoCounts | null>(null);
  const [busy, setBusy] = useState<Busy>('status');
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy('status');
    try {
      setStatus(await demoApi.status(signal));
      setError(null);
    } catch (err) {
      if (!signal?.aborted) {
        console.warn('[demo]', err);
        setError('status');
      }
    } finally {
      if (!signal?.aborted) setBusy(null);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const reset = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy('reset');
    setMessage('');
    try {
      const res = await demoApi.reset();
      const deleted = res.deleted ?? {};
      const n = Object.values(deleted).reduce((a, b) => a + b, 0);
      setMessage(t('demoPage.resetDone', { count: n }));
      setStatus(res);
      onChanged();
    } catch (err) {
      console.warn('[demo reset]', err);
      setError('reset');
    } finally {
      setBusy(null);
    }
  };

  const replayRide = async () => {
    if (!user) return;
    setBusy('ride');
    setMessage('');
    try {
      const s = await rideApi.replayDemo(user.id);
      setMessage(t('demoPage.rideDone', { edges: s.verified_edge_ids.length }));
      onChanged();
      await load();
    } catch (err) {
      console.warn('[demo ride]', err);
      setError('ride');
      setBusy(null);
    }
  };

  const zoneName = status?.zone ? (typeof status.zone.display_name === 'string' ? status.zone.display_name : localized(status.zone.display_name, lang)) : '';
  const pct = (v: number | undefined) => (typeof v === 'number' ? `${Math.round(v)}%` : '–');

  return (
    <div className="page demo">
      <h2 className="page__title">{t('demoPage.title')}</h2>
      <p className="panel__hint">{t('demoPage.intro')}</p>

      <section className="card demo__trips" aria-labelledby="demo-trips">
        <h3 id="demo-trips" className="card__title">
          {t('demoPage.trips')}
        </h3>
        <p className="panel__hint">{t('demoPage.tripsHint')}</p>
        <div className="demo__modes">
          {APP_MODES.map((m) => (
            <button key={m} type="button" className={`demo__mode demo__mode--${m}`} onClick={() => onRunDemo(m)}>
              <Icon name={m === 'move' ? 'route' : m === 'explore' ? 'camera' : 'mic'} size={26} />
              <span className="demo__modeTitle">{t(`mode.${m}.title`)}</span>
              <span className="demo__modeLine">{t(`demoPage.tripFor.${m}`)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="demo-data">
        <div className="card__head">
          <h3 id="demo-data" className="card__title">
            {t('demoPage.data')}
            {zoneName && <span className="card__sub"> · {zoneName}</span>}
          </h3>
          <button type="button" className="btn btn--small btn--ghost" onClick={() => void load()} disabled={busy !== null} aria-busy={busy === 'status'}>
            <Icon name="refresh" size={18} /> {t('demoPage.refresh')}
          </button>
        </div>
        {status ? (
          <>
            <ul className="stattiles">
              <li className="stattile">
                <strong>{status.images?.real ?? 0}</strong>
                <span>{t('demoPage.tiles.realPhotos')}</span>
                <small>{t('demoPage.tiles.ofWhich', { mapillary: status.images?.mapillary ?? 0, own: status.images?.own_photo ?? 0 })}</small>
              </li>
              <li className="stattile">
                <strong>{pct(status.coverage?.pct_real)}</strong>
                <span>{t('demoPage.tiles.coverageReal')}</span>
                <small>{t('demoPage.tiles.edges', { known: status.coverage?.edges_known_real ?? 0, total: status.coverage?.edges_total ?? 0 })}</small>
              </li>
              <li className="stattile">
                <strong>{status.barriers?.real ?? 0}</strong>
                <span>{t('demoPage.tiles.realBarriers')}</span>
                <small>{t('demoPage.tiles.synthetic', { count: status.barriers?.synthetic ?? 0 })}</small>
              </li>
              <li className="stattile">
                <strong>{(status.reports?.pending ?? 0) + (status.reports?.verified ?? 0)}</strong>
                <span>{t('demoPage.tiles.reports')}</span>
                <small>{t('demoPage.tiles.reportsSplit', { pending: status.reports?.pending ?? 0, verified: status.reports?.verified ?? 0 })}</small>
              </li>
              <li className="stattile">
                <strong>{status.rides ?? 0}</strong>
                <span>{t('demoPage.tiles.rides')}</span>
              </li>
              <li className="stattile">
                <strong>{status.users ?? 0}</strong>
                <span>{t('demoPage.tiles.users')}</span>
              </li>
            </ul>
            {status.synthetic_present && (
              <p className="demo__flag">
                <Icon name="warning" size={18} /> {t('demoPage.syntheticNote')}
              </p>
            )}
          </>
        ) : (
          <p className="place__status" role="status">
            {busy === 'status' ? t('demoPage.loading') : t('demoPage.noStatus')}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="demo-actions">
        <h3 id="demo-actions" className="card__title">
          {t('demoPage.actions')}
        </h3>
        <div className="demo__actions">
          <button type="button" className="btn" onClick={() => void replayRide()} disabled={busy !== null || !user} aria-busy={busy === 'ride'}>
            <Icon name="ride" size={20} /> {t('demoPage.replayRide')}
          </button>
          <button type="button" className={`btn ${armed ? 'btn--danger' : ''}`} onClick={() => void reset()} disabled={busy !== null} aria-busy={busy === 'reset'}>
            <Icon name="refresh" size={20} /> {armed ? t('demoPage.resetConfirm') : t('demoPage.reset')}
          </button>
          {armed && (
            <button type="button" className="btn btn--ghost" onClick={() => setArmed(false)}>
              {t('user.cancel')}
            </button>
          )}
        </div>
        <p className="panel__hint">{t('demoPage.resetHint')}</p>
        {!user && <p className="panel__hint">{t('demoPage.needUser')}</p>}
        <p className="place__status" role="status" aria-live="polite">
          {message}
        </p>
        {error && (
          <p className="place__error" role="alert">
            {t(`demoPage.errors.${error}`)}
          </p>
        )}
      </section>

      <section className="card demo__collect" aria-labelledby="demo-collect">
        <h3 id="demo-collect" className="card__title">
          <Icon name="camera" size={22} /> {t('demoPage.collect')}
        </h3>
        <ol className="demo__steps">
          <li>{t('demoPage.collectSteps.1')}</li>
          <li>{t('demoPage.collectSteps.2')}</li>
          <li>{t('demoPage.collectSteps.3')}</li>
          <li>{t('demoPage.collectSteps.4')}</li>
        </ol>
        <a className="btn btn--primary" href={hrefFor('capture')}>
          {t('demoPage.openCapture')}
        </a>
      </section>
    </div>
  );
}
