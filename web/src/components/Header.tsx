import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { Zone } from '../api';
import { localized } from '../api';
import { LANGS, type Lang } from '../i18n';
import { hrefFor, ROUTES, type Route } from '../router';

interface HeaderProps {
  zone: Zone | null;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  highContrast: boolean;
  onToggleContrast: () => void;
  legendOpen: boolean;
  onToggleLegend: () => void;
  listOpen: boolean;
  onToggleList: () => void;
  plannerOpen: boolean;
  onTogglePlanner: () => void;
  /** Opener refs so closing a panel can return focus to its toggle. */
  plannerBtnRef: RefObject<HTMLButtonElement>;
  legendBtnRef: RefObject<HTMLButtonElement>;
  listBtnRef: RefObject<HTMLButtonElement>;
  /** The "Reach Gap" nav link: closing that page returns focus here. */
  reachLinkRef?: RefObject<HTMLAnchorElement>;
  synthetic: boolean;
  /** Live status line (aria-live region) rendered inside the header. */
  status: ReactNode;
  route: Route;
}

export default function Header(props: HeaderProps) {
  const { t } = useTranslation();
  const { zone, lang } = props;

  return (
    <>
      <header className="header">
        <div className="header__text">
          <h1 className="header__title">
            {t('app.name')} <span className="header__tagline">{t('app.tagline')}</span>
          </h1>
          <p className="header__zone">
            <span className="sr-only">{t('header.zoneLabel')}: </span>
            {zone ? localized(zone.display_name, lang) : t('header.zoneUnknown')}
            {props.synthetic && <span className="badge badge--synthetic">{t('badge.synthetic')}</span>}
          </p>
          {props.status}
        </div>
        <nav className="nav" aria-label={t('nav.label')}>
          {ROUTES.map((r) => (
            <a
              key={r}
              ref={r === 'reach' ? props.reachLinkRef : undefined}
              className="nav__link"
              href={hrefFor(r)}
              aria-current={props.route === r ? 'page' : undefined}
            >
              {t(`nav.${r}`)}
            </a>
          ))}
        </nav>
      </header>

      <nav className="toolbar" aria-label={t('app.name')}>
        <div className="toolbar__group" role="group" aria-label={t('lang.label')}>
          {LANGS.map((code) => (
            <button
              key={code}
              type="button"
              className="btn"
              lang={code}
              aria-pressed={lang === code}
              onClick={() => props.onLangChange(code)}
            >
              {t(`lang.${code}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn"
          aria-pressed={props.highContrast}
          onClick={props.onToggleContrast}
        >
          {t('theme.highContrast')}
        </button>
        {props.route === 'map' && (
          <button
            ref={props.plannerBtnRef}
            type="button"
            className="btn"
            aria-expanded={props.plannerOpen}
            aria-controls="panel-route"
            onClick={props.onTogglePlanner}
          >
            {t('route.open')}
          </button>
        )}
        {(props.route === 'map' || props.route === 'reach') && (
          <button
            ref={props.legendBtnRef}
            type="button"
            className="btn"
            aria-expanded={props.legendOpen}
            aria-controls="panel-legend"
            onClick={props.onToggleLegend}
          >
            {t('panels.legend')}
          </button>
        )}
        {props.route === 'map' && (
          <button
            ref={props.listBtnRef}
            type="button"
            className="btn"
            aria-expanded={props.listOpen}
            aria-controls="panel-list"
            onClick={props.onToggleList}
          >
            {t('panels.barriers')}
          </button>
        )}
      </nav>
    </>
  );
}
