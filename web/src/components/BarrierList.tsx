import { useMemo, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { BarrierFeature } from '../api';
import { localizedName } from '../api';
import type { Lang } from '../i18n';

interface BarrierListProps {
  barriers: readonly BarrierFeature[];
  lang: Lang;
  selectedId: number | null;
  onSelect: (feature: BarrierFeature) => void;
  onClose: () => void;
  headingRef?: RefObject<HTMLHeadingElement>;
}

/** Screen-reader friendly alternative to the map: every barrier as a focusable button. */
export default function BarrierList({ barriers, lang, selectedId, onSelect, onClose, headingRef }: BarrierListProps) {
  const { t } = useTranslation();

  const sorted = useMemo(
    () => [...barriers].sort((a, b) => b.properties.severity - a.properties.severity || a.properties.id - b.properties.id),
    [barriers],
  );

  return (
    <div className="panel__inner">
      <div className="panel__head">
        <h2 id="list-title" className="panel__title" ref={headingRef} tabIndex={-1}>
          {t('list.title')} <span className="panel__count">({t('list.count', { count: sorted.length })})</span>
        </h2>
        <button type="button" className="btn btn--icon" onClick={onClose} aria-label={t('panels.close')}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <p className="panel__hint">{t('list.hint')}</p>

      {sorted.length === 0 ? (
        <p className="panel__empty">{t('list.empty')}</p>
      ) : (
        <ul className="list">
          {sorted.map((f) => {
            const p = f.properties;
            const name = localizedName(p, lang);
            const className = t(`barrierClass.${p.class}`, { defaultValue: p.class });
            const severityText = `${t('severity.label')} ${p.severity}: ${t(`severity.${p.severity}`)}`;
            return (
              <li key={p.id} className="list__item">
                <button
                  type="button"
                  className="list__btn"
                  aria-current={selectedId === p.id ? 'true' : undefined}
                  aria-label={`${t('list.show', { name })}. ${severityText}. ${className}.`}
                  onClick={() => onSelect(f)}
                >
                  <span className="list__name">{name}</span>
                  <span className="list__meta">
                    <span className={`sev sev--${p.severity}`} aria-hidden="true">{p.severity}</span> {severityText} · {className}
                    {p.synthetic && <span className="badge badge--synthetic">{t('badge.synthetic')}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
