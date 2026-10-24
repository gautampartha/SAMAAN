// Settings: language, contrast, who you are (display name + trust) and the
// travel profile (from GET /profiles; picking one also picks its mode).
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RISKS, type Profile, type Risk } from '../api';
import { LANGS, type Lang } from '../i18n';
import type { RoutePlannerApi } from '../routePlanner';
import UserDialog, { UserChip } from './UserDialog';
import { Icon, PROFILE_ICONS } from '../icons';
import { hrefFor } from '../router';

interface SettingsPageProps {
  planner: RoutePlannerApi;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  highContrast: boolean;
  onToggleContrast: () => void;
  onProfile: (profile: Profile) => void;
}

export default function SettingsPage({ planner, lang, onLangChange, highContrast, onToggleContrast, onProfile }: SettingsPageProps) {
  const { t } = useTranslation();
  const id = useId();
  const [userDialog, setUserDialog] = useState(false);
  const { state } = planner;

  return (
    <div className="page settings">
      <h2 className="page__title">{t('settings.title')}</h2>

      <section className="card" aria-labelledby={`${id}-lang`}>
        <h3 id={`${id}-lang`} className="card__title">
          {t('lang.label')}
        </h3>
        <div className="segmented" role="group" aria-label={t('lang.label')}>
          {LANGS.map((code) => (
            <button key={code} type="button" className="btn segmented__btn" lang={code} aria-pressed={lang === code} onClick={() => onLangChange(code)}>
              {t(`lang.${code}`)}
            </button>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby={`${id}-display`}>
        <h3 id={`${id}-display`} className="card__title">
          {t('settings.display')}
        </h3>
        <button type="button" className="btn" aria-pressed={highContrast} onClick={onToggleContrast}>
          {t('theme.highContrast')}
        </button>
      </section>

      <section className="card" aria-labelledby={`${id}-profile`}>
        <h3 id={`${id}-profile`} className="card__title">
          {t('route.profile.label')}
        </h3>
        {!state.profilesFromApi && <p className="panel__hint">{t('settings.profilesFallback')}</p>}
        <fieldset className="choices">
          <legend className="sr-only">{t('route.profile.label')}</legend>
          {state.profiles.map((p) => {
            const name = lang === 'hi' ? p.name_hi || p.name_en : p.name_en;
            const desc = lang === 'hi' ? p.description_hi || p.description_en : p.description_en;
            return (
              <label key={p.id} className="choice choice--stacked">
                <input type="radio" name={`${id}-profile`} value={p.id} checked={state.profile === p.id} onChange={() => onProfile(p.id)} />
                <span className="choice__glyph" aria-hidden="true">
                  <Icon name={PROFILE_ICONS[p.id] ?? 'wheelchair'} size={22} />
                </span>
                <span className="choice__text">
                  <span className="choice__name" lang={lang}>
                    {name} <span className="choice__mode">· {t(`mode.${p.mode === 'baseline' ? 'move' : p.mode}.title`)}</span>
                  </span>
                  {desc && (
                    <span className="choice__hint" lang={lang}>
                      {desc}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      </section>

      <section className="card" aria-labelledby={`${id}-risk`}>
        <h3 id={`${id}-risk`} className="card__title">
          {t('route.risk.label')}
        </h3>
        <fieldset className="choices">
          <legend className="sr-only">{t('route.risk.label')}</legend>
          {RISKS.map((r: Risk) => (
            <label key={r} className="choice choice--stacked">
              <input type="radio" name={`${id}-risk`} value={r} checked={state.risk === r} onChange={() => planner.setRisk(r)} />
              <span className="choice__text">
                <span className="choice__name">{t(`route.risk.${r}`)}</span>
                <span className="choice__hint">{t(`route.risk.${r}Hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card" aria-labelledby={`${id}-user`}>
        <h3 id={`${id}-user`} className="card__title">
          {t('user.title')}
        </h3>
        <p className="panel__hint">{t('user.intro')}</p>
        <UserChip onChange={() => setUserDialog(true)} />
        <div className="planner__actions">
          <a className="btn btn--primary" href={hrefFor('welcome')}>
            {t('settings.rerunWelcome')}
          </a>
          <button type="button" className="btn" onClick={() => setUserDialog(true)}>
            {t('settings.setUser')}
          </button>
        </div>
      </section>

      {userDialog && <UserDialog lang={lang} onDone={() => setUserDialog(false)} onCancel={() => setUserDialog(false)} />}
    </div>
  );
}
