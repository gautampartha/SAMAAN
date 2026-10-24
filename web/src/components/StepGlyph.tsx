// Pictograms for turn-by-turn step types (SVG, `currentColor`, no text). Used in
// the black turn banner, the route-choice step list and, large, in Explore mode.
import type { StepType } from '../api';

const ARROW_HEAD = 'M50 14 L36 30 M50 14 L64 30';

const PATHS: Record<StepType, string> = {
  depart: 'M50 86 L50 22 ' + ARROW_HEAD,
  straight: 'M50 88 L50 16 ' + ARROW_HEAD,
  slight_left: 'M54 88 L54 56 L34 32 M34 32 L34 50 M34 32 L52 32',
  left: 'M58 88 L58 50 L22 50 M22 50 L36 36 M22 50 L36 64',
  sharp_left: 'M60 86 L60 36 L28 68 M28 68 L30 48 M28 68 L48 66',
  slight_right: 'M46 88 L46 56 L66 32 M66 32 L66 50 M66 32 L48 32',
  right: 'M42 88 L42 50 L78 50 M78 50 L64 36 M78 50 L64 64',
  sharp_right: 'M40 86 L40 36 L72 68 M72 68 L70 48 M72 68 L52 66',
  uturn: 'M64 88 L64 40 A14 14 0 0 0 36 40 L36 66 M36 66 L24 52 M36 66 L48 52',
  cross: 'M50 86 L50 30 ' + ARROW_HEAD,
  arrive: 'M50 90 L50 18 M50 18 L80 30 L50 42',
};

const KNOWN = new Set(Object.keys(PATHS));

export function stepTypeOf(type: string): StepType {
  return KNOWN.has(type) ? (type as StepType) : 'straight';
}

interface StepGlyphProps {
  type: string;
  size?: number;
  className?: string;
}

export default function StepGlyph({ type, size = 48, className }: StepGlyphProps) {
  const kind = stepTypeOf(type);
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="11"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'cross' && (
        <g strokeWidth="6" opacity="0.55">
          <path d="M14 62 H86" />
          <path d="M14 74 H86" />
          <path d="M14 86 H86" />
        </g>
      )}
      {kind === 'depart' && <circle cx="50" cy="88" r="7" fill="currentColor" stroke="none" />}
      <path d={PATHS[kind]} />
      {kind === 'arrive' && <path d="M50 18 L80 30 L50 42 Z" fill="currentColor" stroke="none" />}
    </svg>
  );
}

/** A single big arrow that is rotated by CSS to point where to go (Explore mode). */
export function BigArrow({ size = 220 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="12"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M50 92 L50 14" />
      <path d="M22 42 L50 12 L78 42" />
    </svg>
  );
}
