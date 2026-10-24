// More tab: the remaining pages as a list of rows.
import { useTranslation } from 'react-i18next';
import { hrefFor, MORE_ROUTES } from '../router';

export default function MorePage() {
  const { t } = useTranslation();
  return (
    <div className="page more">
      <h2 className="page__title">{t('tabs.more')}</h2>
      <ul className="linklist">
        {MORE_ROUTES.map((r) => (
          <li key={r}>
            <a className="linkrow" href={hrefFor(r)}>
              <span className="linkrow__title">{t(`nav.${r}`)}</span>
              <span className="linkrow__hint">{t(`more.${r}`)}</span>
              <span className="linkrow__chev" aria-hidden="true">
                ›
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="panel__hint more__about">{t('more.about')}</p>
    </div>
  );
}
