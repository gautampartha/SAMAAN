// Contribute tab: the consent toggle "Contribute photos while I navigate", a
// short explanation of why SAMAAN needs fresh photos, the upload queue status
// and links to Capture, Ride, Missions and Report.
import { useTranslation } from 'react-i18next';
import { hrefFor } from '../router';
import { useUploadQueue } from '../uploadQueue';

interface ContributePageProps {
  contribute: boolean;
  onToggle: (on: boolean) => void;
  onReport: () => void;
}

export default function ContributePage({ contribute, onToggle, onReport }: ContributePageProps) {
  const { t } = useTranslation();
  const queue = useUploadQueue();
  return (
    <div className="page contribute">
      <h2 className="page__title">{t('contribute.title')}</h2>
      <p className="panel__hint">{t('contribute.intro')}</p>

      <div className="card card--toggle">
        <button type="button" role="switch" aria-checked={contribute} className="switch" onClick={() => onToggle(!contribute)} id="contribute-switch">
          <span className="switch__track" aria-hidden="true">
            <span className="switch__knob" />
          </span>
          <span className="switch__text">
            <span className="switch__title">{t('contribute.toggle')}</span>
            <span className="switch__hint">{contribute ? t('contribute.on') : t('contribute.off')}</span>
          </span>
        </button>
        <p className="panel__hint">{t('contribute.how')}</p>
      </div>

      <div className="card">
        <h3 className="card__title">{t('queue.title')}</h3>
        <ul className="queue__counters">
          <li>
            <strong>{queue.captured}</strong>
            {t('queue.captured')}
          </li>
          <li>
            <strong>{queue.uploaded}</strong>
            {t('queue.uploaded')}
          </li>
          <li>
            <strong>{queue.pending}</strong>
            {t('queue.pending')}
          </li>
          <li>
            <strong>{queue.failed}</strong>
            {t('queue.failed')}
          </li>
        </ul>
        <p className="queue__status" role="status" aria-live="polite">
          {!queue.online ? t('queue.offline') : queue.uploading ? t('queue.uploading') : queue.retryInSec !== null ? t('queue.retryIn', { seconds: queue.retryInSec }) : t('queue.idle')}
        </p>
      </div>

      <ul className="linklist">
        <li>
          <a className="linkrow" href={hrefFor('capture')}>
            <span className="linkrow__title">{t('nav.capture')}</span>
            <span className="linkrow__hint">{t('contribute.captureHint')}</span>
          </a>
        </li>
        <li>
          <a className="linkrow" href={hrefFor('ride')}>
            <span className="linkrow__title">{t('nav.ride')}</span>
            <span className="linkrow__hint">{t('contribute.rideHint')}</span>
          </a>
        </li>
        <li>
          <a className="linkrow" href={hrefFor('missions')}>
            <span className="linkrow__title">{t('nav.missions')}</span>
            <span className="linkrow__hint">{t('contribute.missionsHint')}</span>
          </a>
        </li>
        <li>
          <button type="button" className="linkrow linkrow--btn" onClick={onReport}>
            <span className="linkrow__title">{t('report.fab')}</span>
            <span className="linkrow__hint">{t('contribute.reportHint')}</span>
          </button>
        </li>
      </ul>
    </div>
  );
}
