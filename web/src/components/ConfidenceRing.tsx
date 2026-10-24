// Confidence of a route as an SVG ring with the percentage inside and the label
// (high / medium / low) as text next to it, so the meaning never rests on colour.
import { useTranslation } from 'react-i18next';
import type { RouteConfidence } from '../api';

interface ConfidenceRingProps {
  confidence: RouteConfidence | null | undefined;
  size?: number;
  /** Show the label text under the ring (default) or only the ring + sr text. */
  showLabel?: boolean;
}

export default function ConfidenceRing({ confidence, size = 64, showLabel = true }: ConfidenceRingProps) {
  const { t } = useTranslation();
  const score = Math.max(0, Math.min(1, confidence?.score ?? 0));
  const label = confidence?.label ?? 'low';
  const pct = Math.round(score * 100);
  const r = 42;
  const c = 2 * Math.PI * r;
  const text = t('confidence.summary', { pct, label: t(`confidence.${label}`) });
  return (
    <div className={`cring cring--${label}`} role="img" aria-label={text}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--c-line)" strokeWidth="10" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          className="cring__arc"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${c * score} ${c}`}
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="50" textAnchor="middle" dominantBaseline="central" className="cring__pct">
          {pct}%
        </text>
      </svg>
      {showLabel && (
        <span className="cring__label" aria-hidden="true">
          {t('confidence.title')}: {t(`confidence.${label}`)}
        </span>
      )}
    </div>
  );
}
