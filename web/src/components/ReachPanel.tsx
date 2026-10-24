import { useId, useMemo, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { localizedName, REACH_CUTOFFS, REACH_PROFILES, RISKS, type ReachCutoff, type ReachFix, type Risk } from '../api';
import type { Lang } from '../i18n';
import type { ReachGapApi } from '../reach';
import { PROFILE_GLYPHS } from './UserDialog';

interface ReachPanelProps {
  reach: ReachGapApi;
  lang: Lang;
  onClose: () => void;
  /** Receives the heading element so navigation can move focus to it. */
  headingRef: RefObject<HTMLHeadingElement>;
  /** "Show" on a fix row: fly the map to that barrier. */
  onShowBarrier: (fix: ReachFix) => void;
}

/** One decimal everywhere ("4.2 km"); the locale decides the separator. */
function useKm(lang: Lang) {
  return useMemo(() => {
    const one = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const upToTwo = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
    return { one: (n: number) => one.format(n), upToTwo: (n: number) => upToTwo.format(n) };
  }, [lang]);
}

// ---------- One fix row ----------

interface FixRowProps {
  fix: ReachFix;
  checked: boolean;
  lang: Lang;
  onToggle: () => void;
  onShow: () => void;
}

function FixRow({ fix, checked, lang, onToggle, onShow }: FixRowProps) {
  const { t } = useTranslation();
  const fmt = useKm(lang);
  const b = fix.barrier;
  const name = localizedName(b, lang);
  const gain = fmt.one(fix.gain_km);
  const cum = fmt.one(fix.cumulative_reach_km);

  let cost: string;
  if (fix.cost_lakh_min === null || fix.cost_lakh_max === null) {
    cost = t('reach.costNone');
  } else {
    const min = fmt.upToTwo(fix.cost_lakh_min);
    const max = fmt.upToTwo(fix.cost_lakh_max);
    cost = fix.cost_lakh_min === fix.cost_lakh_max ? t('reach.costSingle', { v: min }) : t('reach.costRange', { min, max });
    if (fix.cost_is_estimate) cost += t('reach.costEstimate');
  }
  const hasCost = fix.cost_lakh_min !== null && fix.cost_lakh_max !== null;

  return (
    <li className={`fix${checked ? ' fix--on' : ''}`} lang={lang}>
      <div className="fix__head">
        <span className="rcard__index" aria-hidden="true">
          {fix.rank}
        </span>
        <span className="fix__name">
          <span className="sr-only">{t('reach.rank', { rank: fix.rank })}: </span>
          {name}
        </span>
        <span className="fix__sev">
          {t('severity.label')} {b.severity}: {t(`severity.${b.severity}`)}
        </span>
        {b.synthetic && <span className="badge badge--synthetic">{t('badge.synthetic')}</span>}
      </div>
      <p className="fix__gain">
        <span className="sr-only">{t('reach.gainSr', { gain, total: cum })}</span>
        <span aria-hidden="true">
          <strong className="fix__plus">
            +{gain} {t('reach.km')}
          </strong>{' '}
          <span className="fix__cum">
            → {cum} {t('reach.km')}
          </span>
        </span>
      </p>
      <p className="fix__cost">
        <span>{cost}</span>
        {fix.gain_km_per_lakh !== null && <span> · {t('reach.gainPerLakh', { v: fmt.upToTwo(fix.gain_km_per_lakh) })}</span>}
        {hasCost && fix.cost_source && <span className="fix__source"> · {t('reach.costSource', { source: fix.cost_source })}</span>}
      </p>
      <div className="fix__actions">
        <label className="toggle fix__sim">
          <input type="checkbox" checked={checked} onChange={onToggle} />
          <span>{t('reach.simulateFix', { name })}</span>
        </label>
        <button type="button" className="btn btn--small" onClick={onShow} aria-label={t('reach.showBarrier', { name })}>
          {t('reach.show')}
        </button>
      </div>
    </li>
  );
}

// ---------- Panel ----------

export default function ReachPanel({ reach, lang, onClose, headingRef, onShowBarrier }: ReachPanelProps) {
  const { t } = useTranslation();
  const id = useId();
  const fmt = useKm(lang);
  const { state } = reach;
  const result = state.result;
  const person = t(`reach.person.${state.profile}`);

  const ratioPct = result && result.ratio !== null ? Math.round(result.ratio * 100) : null;
  const allChecked = Boolean(result && result.fixes.length > 0 && result.fixes.every((f) => state.fixed.includes(f.barrier.id)));

  // Announced when a result arrives (the text only changes when the numbers do).
  const live = result
    ? t('reach.live', { walker: fmt.one(result.walker.reach_km), profile: person, target: fmt.one(result.target.reach_km), gap: fmt.one(result.gap_km) }) +
      (result.simulated && result.simulated_gap_km !== null
        ? ' ' + t('reach.liveSim', { km: fmt.one(result.simulated.reach_km), gap: fmt.one(result.simulated_gap_km) })
        : '')
    : '';

  return (
    <div className="panel__inner reachp">
      <div className="panel__head">
        <h2 id="reach-title" className="panel__title" ref={headingRef} tabIndex={-1}>
          {t('reach.title')}
        </h2>
        <button type="button" className="btn btn--icon" onClick={onClose} aria-label={t('panels.close')}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <p className="panel__hint">{t('reach.intro')}</p>

      {result?.synthetic_overlay && (
        <p className="reachp__synthetic">
          <span className="badge badge--synthetic">{t('badge.synthetic')}</span> <span className="panel__hint">{t('reach.syntheticHint')}</span>
        </p>
      )}

      <div className="field">
        <label className="field__label" htmlFor={`${id}-anchor`}>
          {t('reach.anchor')}
        </label>
        <select
          id={`${id}-anchor`}
          className="reachp__select"
          value={state.anchorId === null ? '' : String(state.anchorId)}
          disabled={state.anchors.length === 0}
          onChange={(e) => {
            const a = state.anchors.find((x) => String(x.id) === e.target.value);
            if (a) reach.setAnchor(a.id);
          }}
          lang={lang}
        >
          {state.anchors.length === 0 && <option value="">{state.anchorsLoading ? t('reach.loadingAnchors') : t('reach.noAnchors')}</option>}
          {state.anchors.map((a) => (
            <option key={String(a.id)} value={String(a.id)}>
              {localizedName(a, lang)} · {t(`anchorKind.${a.kind}`, { defaultValue: String(a.kind) })}
            </option>
          ))}
        </select>
        {state.anchorsError && (
          <div className="reachp__inline">
            <p className="place__error" role="alert">
              {t('reach.errors.anchors')}
            </p>
            <button type="button" className="btn" onClick={reach.retryAnchors}>
              {t('validate.reload')}
            </button>
          </div>
        )}
      </div>

      <fieldset className="choices choices--row">
        <legend className="field__label">{t('reach.profileLabel')}</legend>
        {REACH_PROFILES.map((p) => (
          <label key={p} className="choice">
            <input type="radio" name={`${id}-profile`} value={p} checked={state.profile === p} onChange={() => reach.setProfile(p)} />
            <span className="choice__glyph" aria-hidden="true">
              {PROFILE_GLYPHS[p]}
            </span>
            <span className="choice__text">{t(`route.profile.${p}`)}</span>
          </label>
        ))}
      </fieldset>
      <p className="panel__hint">{t('reach.walkerBaseline')}</p>

      <div className="field">
        <span className="field__label" id={`${id}-cutoff`}>
          {t('reach.cutoff')}
        </span>
        <div className="segmented" role="group" aria-labelledby={`${id}-cutoff`}>
          {REACH_CUTOFFS.map((c: ReachCutoff) => (
            <button key={c} type="button" className="btn segmented__btn" aria-pressed={state.cutoff === c} onClick={() => reach.setCutoff(c)}>
              {t('reach.minutes', { count: c })}
            </button>
          ))}
        </div>
      </div>

      <section className="headline" aria-labelledby={`${id}-headline`} aria-busy={state.loading}>
        <h3 id={`${id}-headline`} className="sr-only">
          {t('reach.headlineTitle')}
        </h3>
        {result ? (
          <>
            {/* Each tile's left border repeats its blob's outline pattern (solid / dashed / dotted). */}
            <div className="headline__grid">
              <p className="stat stat--walker" lang={lang}>
                <span className="stat__who">{t('reach.headline.walker')}</span>{' '}
                <strong className="stat__num">
                  {fmt.one(result.walker.reach_km)} {t('reach.km')}
                </strong>
              </p>
              <p className="stat stat--target" lang={lang}>
                <span className="stat__who">{t('reach.headline.target', { profile: person })}</span>{' '}
                <strong className="stat__num">
                  {fmt.one(result.target.reach_km)} {t('reach.km')}
                </strong>
              </p>
            </div>
            <p className="stat stat--gap" lang={lang}>
              <span className="stat__who">{t('reach.headline.gap')}</span>{' '}
              <strong className="stat__num">
                {fmt.one(result.gap_km)} {t('reach.km')}
                {ratioPct !== null && <span className="stat__pct"> ({ratioPct}%)</span>}
              </strong>
            </p>
            <p className="headline__sentence" lang={lang}>
              {ratioPct !== null ? t(`reach.ratio.${state.profile}`, { pct: ratioPct }) : t('reach.ratioNone')}
            </p>
            {result.simulated && result.simulated_gap_km !== null && (
              <p className="stat stat--sim" lang={lang}>
                <span className="stat__who">{t('reach.headline.simulated')}</span>{' '}
                <strong className="stat__num">
                  {fmt.one(result.simulated.reach_km)} {t('reach.km')}
                  <span className="stat__pct"> {t('reach.headline.simulatedGap', { gap: fmt.one(result.simulated_gap_km) })}</span>
                </strong>
              </p>
            )}
          </>
        ) : (
          <p className="headline__placeholder">{state.loading ? t('reach.loading') : t('reach.empty')}</p>
        )}
        <p className="headline__measure">{t('reach.measure', { min: state.cutoff })}</p>
      </section>

      <p className="place__status" role="status" aria-live="polite">
        {state.loading ? t('reach.loading') : ''}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      {state.error && (
        <div className="reachp__inline">
          <p className="place__error" role="alert">
            {t(`reach.errors.${state.error}`)}
          </p>
          <button type="button" className="btn" onClick={reach.retry}>
            {t('validate.reload')}
          </button>
        </div>
      )}

      {result && (
        <section className="fixes" aria-labelledby={`${id}-fixes`}>
          <h3 id={`${id}-fixes`} className="panel__subtitle">
            {t('reach.fixesTitle')}
          </h3>
          {result.fixes.length > 0 ? (
            <>
              <p className="panel__hint">{t('reach.fixesHint', { profile: person })}</p>
              <div className="planner__actions">
                <button type="button" className="btn btn--primary" onClick={reach.simulateAll} disabled={allChecked} aria-busy={state.loading}>
                  {t('reach.simulateAll', { count: result.fixes.length })}
                </button>
                <button type="button" className="btn" onClick={reach.clearFixes} disabled={state.fixed.length === 0}>
                  {t('reach.clearSim')}
                </button>
              </div>
              <ol className="fixlist" aria-label={t('reach.fixesTitle')}>
                {result.fixes.map((f) => (
                  <FixRow
                    key={f.barrier.id}
                    fix={f}
                    checked={state.fixed.includes(f.barrier.id)}
                    lang={lang}
                    onToggle={() => reach.toggleFix(f.barrier.id)}
                    onShow={() => onShowBarrier(f)}
                  />
                ))}
              </ol>
            </>
          ) : (
            <p className="rcard__none">{t('reach.noFixes')}</p>
          )}
        </section>
      )}

      <fieldset className="choices">
        <legend className="field__label">{t('route.risk.label')}</legend>
        {RISKS.map((r: Risk) => (
          <label key={r} className="choice choice--stacked">
            <input type="radio" name={`${id}-risk`} value={r} checked={state.risk === r} onChange={() => reach.setRisk(r)} />
            <span className="choice__text">
              <span className="choice__name">{t(`route.risk.${r}`)}</span>
              <span className="choice__hint">{t(`route.risk.${r}Hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
