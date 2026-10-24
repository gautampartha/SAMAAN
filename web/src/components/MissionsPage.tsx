import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedName, missionApi, type MissionFeature } from '../api';
import type { Lang } from '../i18n';
import { navigate } from '../router';
import { CAPTURE_SESSION_KEY } from './CapturePage';

interface MissionsPageProps {
  lang: Lang;
  /** Navigate to the map and highlight this mission's line. */
  onShowOnMap: (mission: MissionFeature) => void;
}

type Phase = 'loading' | 'ready' | 'error';

export default function MissionsPage({ lang, onShowOnMap }: MissionsPageProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('loading');
  const [missions, setMissions] = useState<MissionFeature[]>([]);
  const [recomputing, setRecomputing] = useState(false);
  const [notice, setNotice] = useState<string>('');
  const [recomputeError, setRecomputeError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('loading');
    try {
      const fc = await missionApi.list(10, ac.signal);
      if (ac.signal.aborted) return;
      setMissions([...fc.features].sort((a, b) => a.properties.rank - b.properties.rank));
      setPhase('ready');
    } catch (err) {
      if (ac.signal.aborted) return;
      console.warn('[missions]', err);
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const recompute = async () => {
    if (recomputing) return;
    setRecomputing(true);
    setRecomputeError(false);
    setNotice(t('missions.recomputing'));
    try {
      const res = await missionApi.recompute();
      setNotice(typeof res.routes_sampled === 'number' ? t('missions.recomputed', { routes: res.routes_sampled }) : t('missions.recomputedNoCount'));
      await load();
    } catch (err) {
      console.warn('[missions]', err);
      setNotice('');
      setRecomputeError(true);
    } finally {
      setRecomputing(false);
    }
  };

  const walk = (m: MissionFeature) => {
    try {
      localStorage.setItem(CAPTURE_SESSION_KEY, `mission-${m.properties.id}`);
    } catch {
      /* ignore */
    }
    navigate('capture');
  };

  return (
    <div className="page missions">
      <h2 className="capture__title">{t('missions.title')}</h2>
      <p className="panel__hint">{t('missions.intro')}</p>

      <div className="planner__actions">
        <button type="button" className="btn" onClick={() => void recompute()} aria-busy={recomputing} disabled={recomputing}>
          {recomputing ? t('missions.recomputing') : t('missions.recompute')}
        </button>
      </div>
      <p className="place__status" role="status" aria-live="polite">
        {phase === 'loading' ? t('missions.loading') : notice}
      </p>
      {recomputeError && (
        <p className="place__error" role="alert">
          {t('missions.recomputeError')}
        </p>
      )}
      {phase === 'error' && (
        <>
          <p className="place__error" role="alert">
            {t('missions.error')}
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            {t('validate.reload')}
          </button>
        </>
      )}
      {phase === 'ready' && missions.length === 0 && <p className="rcard__none">{t('missions.empty')}</p>}

      {missions.length > 0 && (
        <ol className="mlist" aria-label={t('missions.title')}>
          {missions.map((m) => {
            const p = m.properties;
            const name = localizedName(p, lang);
            const done = p.status === 'done';
            return (
              <li key={p.id} className={`mission${done ? ' mission--done' : ''}`} lang={lang}>
                <div className="mission__head">
                  <span className="rcard__index" aria-hidden="true">
                    {p.rank}
                  </span>
                  <h3 className="mission__title">
                    <span className="sr-only">{t('missions.rank', { rank: p.rank })}: </span>
                    {name}
                  </h3>
                  <span className={`badge badge--status badge--${done ? 'done' : 'open'}`}>
                    {t(`missions.status.${done ? 'done' : 'open'}`)}
                  </span>
                  {p.synthetic && <span className="badge badge--synthetic">{t('badge.synthetic')}</span>}
                </div>
                <p className="mission__meta">
                  {t('missions.length', { m: Math.round(p.length_m) })} · {t('missions.needed', { count: p.n_routes })}
                </p>
                <div className="planner__actions">
                  <button type="button" className="btn" onClick={() => onShowOnMap(m)}>
                    {t('missions.show')}
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => walk(m)} title={t('missions.walkHint', { id: p.id })}>
                    <span aria-hidden="true">📷 </span>
                    {t('missions.walk')}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
