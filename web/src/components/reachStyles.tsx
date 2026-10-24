// Visual identity of the Reach Gap blobs. Shared by the map layers and the
// legend so they always agree. Each blob differs in outline pattern AND
// colour (solid / dashed / dotted), so they are told apart without colour.
// The legend swatches take their colours from CSS tokens (`--reach-*`) so the
// high-contrast theme can restyle them; the map uses the fixed colours below.

export type ReachBlob = 'walker' | 'target' | 'simulated';
export const REACH_BLOBS: readonly ReachBlob[] = ['walker', 'target', 'simulated'] as const;

export interface ReachBlobStyle {
  fill: string;
  fillOpacity: number;
  line: string;
  lineWidth: number;
  /** MapLibre `line-dasharray` (in line-width units); undefined = solid. */
  dash?: [number, number];
  /** SVG `stroke-dasharray` for the legend swatch. */
  svgDash?: string;
}

export const REACH_STYLES: Record<ReachBlob, ReachBlobStyle> = {
  walker: { fill: '#64b5f6', fillOpacity: 0.25, line: '#0d47a1', lineWidth: 2.5 },
  target: { fill: '#7e57c2', fillOpacity: 0.35, line: '#4527a0', lineWidth: 2.5, dash: [3, 2], svgDash: '7 4' },
  simulated: { fill: '#43a047', fillOpacity: 0.35, line: '#1b5e20', lineWidth: 3, dash: [0.1, 2], svgDash: '0.5 6' },
};

export const REACH_ANCHOR_COLOUR = '#1a237e';
export const REACH_FIX_COLOUR = '#311b92';
export const REACH_FIX_DONE_COLOUR = '#1b5e20';

/** Filled blob with its outline; colours come from `--reach-<blob>-fill/line` tokens. */
export function ReachBlobSwatch({ blob }: { blob: ReachBlob }) {
  const s = REACH_STYLES[blob];
  return (
    <svg className={`swatch rswatch rswatch--${blob}`} viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <rect x="4" y="3" width="48" height="18" rx="9" strokeWidth={s.lineWidth} strokeDasharray={s.svgDash} />
    </svg>
  );
}

/** Dark star with a white edge: the anchor of the reach computation. */
export function ReachAnchorSwatch() {
  return (
    <svg className="swatch rswatch rswatch--anchor" viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <path d="M28 2.5 L31.2 9.3 L38.6 10.2 L33.2 15.3 L34.6 22.6 L28 19 L21.4 22.6 L22.8 15.3 L17.4 10.2 L24.8 9.3 Z" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

/** Numbered pin: a barrier from the to-do list (solid ring; filled green once simulated). */
export function ReachFixSwatch() {
  return (
    <svg className="swatch rswatch rswatch--fix" viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <circle cx="18" cy="12" r="9" strokeWidth="2" />
      <text x="18" y="16" textAnchor="middle" fontSize="11" fontWeight="700">1</text>
      <circle className="rswatch__done" cx="40" cy="12" r="9" strokeWidth="2" />
      <text className="rswatch__doneText" x="40" y="16" textAnchor="middle" fontSize="11" fontWeight="700">2</text>
    </svg>
  );
}
