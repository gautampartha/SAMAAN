// Contribute tab: your points and the partner coupons (CSR pilot catalogue),
// the consent toggle "Contribute photos while I navigate", the upload queue
// and the ways to contribute (Report, Capture, Ride, Missions, Validate).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../icons';
import { COUPONS, POINTS, redeem, useRewards, type RewardKind } from '../rewards';
import { hrefFor } from '../router';
import { useUploadQueue } from '../uploadQueue';

interface ContributePageProps {
  contribute: boolean;
  onToggle: (on: boolean) => void;
  onReport: () => void;
}

const KIND_ICONS: Record<RewardKind, IconName> = { photo: 'camera', report: 'flag', vote: 'check', ride: 'ride', trip: 'route' };
const PARTNER_ICONS: Record<string, IconName> = { campus_cafe: 'gift', metro_ride: 'route', pharmacy: 'star', bookstore: 'sparkle', mobility_service: 'wheelchair' };

export default function ContributePage({ contribute, onToggle, onReport }: ContributePageProps) {
  const { t } = useTranslation();
  const queue = useUploadQueue();
  const rewards = useRewards();
  const [justRedeemed, setJustRedeemed] = useState<string | null>(null);
  const progress = rewards.next ? Math.min(1, rewards.balance / rewards.next.cost) : 1;

  const onRedeem = (id: string) => {
    if (redeem(id)) setJustRedeemed(id);
  };

  return (
    <div className="page contribute">
      <h2 className="page__title">{t('contribute.title')}</h2>

      <section className="rewards" aria-labelledby="rewards-title">
        <div className="rewards__top">
          <div>
            <p id="rewards-title" className="rewards__label">
              {t('rewards.balance')}
            </p>
            <p className="rewards__points">
              <Icon name="coin" size={28} /> {rewards.balance}
              <span className="rewards__unit"> {t('rewards.points')}</span>
            </p>
          </div>
          <button type="button" className="btn btn--primary rewards__report" onClick={onReport}>
            <Icon name="flag" size={20} /> {t('report.short')}
          </button>
        </div>
        <div className="rewards__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label={t('rewards.progressLabel')}>
          <span className="rewards__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="rewards__next">
          {rewards.next ? t('rewards.nextCoupon', { points: rewards.next.cost - rewards.balance, name: t(`rewards.partners.${rewards.next.id}.name`) }) : t('rewards.allUnlocked')}
        </p>
        <ul className="rewards__kinds">
          {(Object.keys(POINTS) as RewardKind[]).map((k) => (
            <li key={k} className="rewards__kind">
              <Icon name={KIND_ICONS[k]} size={18} />
              <span className="rewards__kindText">
                {t(`rewards.kinds.${k}`)} <strong>+{POINTS[k]}</strong>
              </span>
              <span className="rewards__kindCount">×{rewards.counts[k]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="partners-title">
        <h3 id="partners-title" className="card__title">
          <Icon name="gift" size={22} /> {t('rewards.partnersTitle')}
        </h3>
        <p className="panel__hint">{t('rewards.partnersIntro')}</p>
        <ul className="coupons">
          {COUPONS.map((c) => {
            const redeemed = rewards.redeemed.includes(c.id);
            const canAfford = rewards.balance >= c.cost;
            return (
              <li key={c.id} className={`coupon${redeemed ? ' coupon--done' : canAfford ? ' coupon--ready' : ''}`}>
                <span className={`coupon__ico coupon__ico--${c.id}`}>
                  <Icon name={PARTNER_ICONS[c.id] ?? 'gift'} size={22} />
                </span>
                <span className="coupon__body">
                  <span className="coupon__name">{t(`rewards.partners.${c.id}.name`)}</span>
                  <span className="coupon__offer">{t(`rewards.partners.${c.id}.offer`)}</span>
                  <span className="coupon__sector">{t(`rewards.partners.${c.id}.sector`)}</span>
                </span>
                <span className="coupon__action">
                  {redeemed ? (
                    <span className="coupon__code">{t('rewards.redeemed')}</span>
                  ) : (
                    <button type="button" className="btn btn--small" disabled={!canAfford} onClick={() => onRedeem(c.id)}>
                      {t('rewards.redeemFor', { points: c.cost })}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="place__status" role="status" aria-live="polite">
          {justRedeemed ? t('rewards.redeemedMsg', { name: t(`rewards.partners.${justRedeemed}.name`) }) : ''}
        </p>
        <p className="rewards__fineprint">{t('rewards.fineprint')}</p>
      </section>

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

      <h3 className="more__groupTitle">{t('contribute.ways')}</h3>
      <ul className="linklist linklist--grouped">
        <li>
          <button type="button" className="linkrow linkrow--btn linkrow--icon" onClick={onReport}>
            <span className="linkrow__ico linkrow__ico--report">
              <Icon name="flag" size={22} />
            </span>
            <span className="linkrow__body">
              <span className="linkrow__title">{t('report.fab')}</span>
              <span className="linkrow__hint">{t('contribute.reportHint')}</span>
            </span>
          </button>
        </li>
        <li>
          <a className="linkrow linkrow--icon" href={hrefFor('capture')}>
            <span className="linkrow__ico linkrow__ico--capture">
              <Icon name="camera" size={22} />
            </span>
            <span className="linkrow__body">
              <span className="linkrow__title">{t('nav.capture')}</span>
              <span className="linkrow__hint">{t('contribute.captureHint')}</span>
            </span>
          </a>
        </li>
        <li>
          <a className="linkrow linkrow--icon" href={hrefFor('ride')}>
            <span className="linkrow__ico linkrow__ico--ride">
              <Icon name="ride" size={22} />
            </span>
            <span className="linkrow__body">
              <span className="linkrow__title">{t('nav.ride')}</span>
              <span className="linkrow__hint">{t('contribute.rideHint')}</span>
            </span>
          </a>
        </li>
        <li>
          <a className="linkrow linkrow--icon" href={hrefFor('missions')}>
            <span className="linkrow__ico linkrow__ico--missions">
              <Icon name="target" size={22} />
            </span>
            <span className="linkrow__body">
              <span className="linkrow__title">{t('nav.missions')}</span>
              <span className="linkrow__hint">{t('contribute.missionsHint')}</span>
            </span>
          </a>
        </li>
        <li>
          <a className="linkrow linkrow--icon" href={hrefFor('validate')}>
            <span className="linkrow__ico linkrow__ico--validate">
              <Icon name="check" size={22} />
            </span>
            <span className="linkrow__body">
              <span className="linkrow__title">{t('nav.validate')}</span>
              <span className="linkrow__hint">{t('more.validate')}</span>
            </span>
          </a>
        </li>
      </ul>
    </div>
  );
}
