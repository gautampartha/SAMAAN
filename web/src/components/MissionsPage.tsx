import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, isJoltFeature, localizedName, missionApi, type MissionFeature, type WheelsJoltFeature } from '../api';
import type { Lang } from '../i18n';
import { navigate } from '../router';
import { CAPTURE_SESSION_KEY } from './CapturePage';

interface MissionsPageProps {
  lang: Lang;
  /** Navigate to the map and highlight this mission's line. */
  onShowOnMap: (mission: MissionFeature) => void;
  /** Navigate to the map with the Wheels layer on and open this jolt's popup (P9). */
  onShowJolt: (jolt: WheelsJoltFeature) => void;
}

type Phase = 'loading' | 'ready' | 'error';

export default function MissionsPage({ lang, onShowOnMap, onShowJolt }: MissionsPageProps) {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>('loading');
  const [missions, setMissions] = useState<MissionFeature[]>([]);
  const [joltPhase, setJoltPhase] = useState<Phase>('loading');
  const [jolts, setJolts] = useState<WheelsJoltFeature[]>([]);
  const [recomputing, setRecomputing] = useState(false);
  const [notice, setNotice] = useState<string>('');
  const [recomputeError, setRecomputeError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('loading');
    setJoltPhase('loading');
    const [m, w] = await Promise.allSettled([missionApi.list(10, ac.signal), api.wheels(ac.signal)]);
    if (ac.signal.aborted) return;
    if (m.status === 'fulfilled') {
      setMissions([...m.value.features].sort((a, b) => a.properties.rank - b.properties.rank));
      setPhase('ready');
    } else {
      console.warn('[missions]', m.reason);
      setPhase('error');
    }
    if (w.status === 'fulfilled') {
      const points = w.value.features.filter(isJoltFeature).sort((a, b) => b.properties.peak_m_s2 - a.properties.peak_m_s2);
      setJolts(points);
      setJoltPhase('ready');
    } else {
      console.warn('[missions] wheels', w.reason);
      setJoltPhase('error');
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

  const nf1 = useMemo(() => new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [i18n.language]);

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

      {/* ---- P9: jolts felt by wheelchair wheels that still need a photo ---- */}
      <section className="jolts" aria-labelledby="jolts-title">
        <h3 id="jolts-title" className="capture__title">
          {t('missions.joltsTitle')}
        </h3>
        <p className="panel__hint">{t('missions.joltsIntro')}</p>
        <p className="place__status" role="status" aria-live="polite">
          {joltPhase === 'loading' ? t('missions.joltsLoading') : ''}
        </p>
        {joltPhase === 'error' && (
          <p className="place__error" role="alert">
            {t('missions.joltsError')}
          </p>
        )}
        {joltPhase === 'ready' && jolts.length === 0 && <p className="rcard__none">{t('missions.joltsEmpty')}</p>}
        {jolts.length > 0 && (
          <ol className="mlist" aria-label={t('missions.joltsTitle')}>
            {jolts.map((j, i) => {
              const p = j.properties;
              const name = localizedName(p, lang);
              return (
                <li key={p.barrier_id} className="mission mission--jolt" lang={lang}>
                  <div className="mission__head">
                    <span className="rcard__index rcard__index--jolt" aria-hidden="true">
                      !
                    </span>
                    <h4 className="mission__title">
                      <span className="sr-only">{t('missions.joltRank', { rank: i + 1 })}: </span>
                      {name}
                    </h4>
                    <span className="badge badge--status badge--open">{t('status.suspected')}</span>
                    {p.synthetic && <span className="badge badge--synthetic">{t('badge.synthetic')}</span>}
                  </div>
                  <p className="mission__meta">
                    {t(`barrierClass.${p.class}`, { defaultValue: String(p.class) })} · {t('missions.joltPeak', { v: nf1.format(p.peak_m_s2) })}
                  </p>
                  <div className="planner__actions">
                    <button type="button" className="btn btn--primary" onClick={() => onShowJolt(j)} aria-label={`${t('missions.show')}: ${name}`}>
                      {t('missions.show')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
