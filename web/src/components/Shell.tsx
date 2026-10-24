// App shell pieces: the thin status strip at the top (zone name, synthetic badge,
// live load status) and the bottom tab bar (Home / Navigate / Contribute / More).
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { localized, type Zone } from '../api';
import type { Lang } from '../i18n';
import { hrefFor, TABS, type Route, type Tab, tabFor } from '../router';

interface StatusStripProps {
  zone: Zone | null;
  lang: Lang;
  synthetic: boolean;
  status: ReactNode;
}

export function StatusStrip({ zone, lang, synthetic, status }: StatusStripProps) {
  const { t } = useTranslation();
  return (
    <header className="strip">
      <p className="strip__zone">
        <span className="strip__brand">{t('app.name')}</span>
        <span className="strip__dot" aria-hidden="true">
          ·
        </span>
        <span className="sr-only">{t('header.zoneLabel')}: </span>
        <span className="strip__zoneName">{zone ? localized(zone.display_name, lang) : t('header.zoneUnknown')}</span>
        {synthetic && <span className="badge badge--synthetic badge--tiny">{t('badge.synthetic')}</span>}
      </p>
      {status}
    </header>
  );
}

const TAB_ICONS: Record<Tab, ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
      <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  ),
  navigate: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
      <path d="M12 3 20 20l-8-4-8 4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  ),
  contribute: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="2" fill="currentColor" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <circle cx="19" cy="12" r="2" fill="currentColor" />
    </svg>
  ),
};

export function TabBar({ route }: { route: Route }) {
  const { t } = useTranslation();
  const current = tabFor(route);
  return (
    <nav className="tabbar" aria-label={t('nav.label')}>
      {TABS.map((tab) => (
        <a key={tab} className="tabbar__tab" href={hrefFor(tab)} aria-current={current === tab ? 'page' : undefined}>
          <span className="tabbar__icon">{TAB_ICONS[tab]}</span>
          <span className="tabbar__label">{t(`tabs.${tab}`)}</span>
        </a>
      ))}
    </nav>
  );
}
