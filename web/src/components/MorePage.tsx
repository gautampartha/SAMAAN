// More tab: the remaining pages grouped (Demo & data, Community, Planning, App),
// each row with an icon, a title and a one-line hint.
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../icons';
import { hrefFor, MORE_GROUPS, type Route } from '../router';

const ROUTE_ICONS: Partial<Record<Route, IconName>> = {
  demo: 'play',
  map: 'map',
  stats: 'chart',
  validate: 'check',
  missions: 'target',
  capture: 'camera',
  ride: 'ride',
  reach: 'route',
  settings: 'settings',
};

export default function MorePage() {
  const { t } = useTranslation();
  return (
    <div className="page more">
      <h2 className="page__title">{t('tabs.more')}</h2>
      {MORE_GROUPS.map((g) => (
        <section key={g.id} className="more__group" aria-labelledby={`more-${g.id}`}>
          <h3 id={`more-${g.id}`} className="more__groupTitle">
            {t(`more.groups.${g.id}`)}
          </h3>
          <ul className="linklist linklist--grouped">
            {g.routes.map((r) => (
              <li key={r}>
                <a className="linkrow linkrow--icon" href={hrefFor(r)}>
                  <span className={`linkrow__ico linkrow__ico--${r}`}>
                    <Icon name={ROUTE_ICONS[r] ?? 'chevron'} size={22} />
                  </span>
                  <span className="linkrow__body">
                    <span className="linkrow__title">{t(`nav.${r}`)}</span>
                    <span className="linkrow__hint">{t(`more.${r}`)}</span>
                  </span>
                  <span className="linkrow__chev" aria-hidden="true">
                    <Icon name="chevron" size={18} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="panel__hint more__about">{t('more.about')}</p>
    </div>
  );
}
