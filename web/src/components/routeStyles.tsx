// Visual identity of the three compared routes. Shared by the map layers, the
// legend and the comparison cards so they always agree. Each style differs in
// width AND dash pattern, so routes are told apart without colour.
import type { RouteMode } from '../api';

export interface RouteStyle {
  colour: string;
  width: number;
  /** MapLibre `line-dasharray` (in line-width units); undefined = solid. */
  dash?: [number, number];
  /** SVG `stroke-dasharray` for the legend / card swatch. */
  svgDash?: string;
  casing: boolean;
  /** Digit shown in tab buttons and sr-only summaries. */
  index: 1 | 2 | 3;
}

export const ROUTE_STYLES: Record<RouteMode, RouteStyle> = {
  shortest: { colour: '#1565c0', width: 2.5, dash: [3, 2], svgDash: '9 6', casing: false, index: 1 },
  naive_accessible: { colour: '#e65100', width: 4, dash: [0.1, 2], svgDash: '0.5 8', casing: false, index: 2 },
  samaan: { colour: '#5e35b1', width: 6, casing: true, index: 3 },
};

export const ROUTE_ENDPOINT_COLOURS = { origin: '#1b5e20', destination: '#5e35b1' } as const;
export const UNKNOWN_OVERLAY_COLOUR = '#424242';

export function RouteSwatch({ mode }: { mode: RouteMode }) {
  const s = ROUTE_STYLES[mode];
  return (
    <svg className="swatch" viewBox="0 0 56 16" width="56" height="16" aria-hidden="true" focusable="false">
      {s.casing && <line x1="4" y1="8" x2="52" y2="8" stroke="#ffffff" strokeWidth={s.width + 5} strokeLinecap="round" />}
      <line
        x1="4"
        y1="8"
        x2="52"
        y2="8"
        stroke={s.colour}
        strokeWidth={s.width}
        strokeDasharray={s.svgDash}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function UnknownOverlaySwatch() {
  return (
    <svg className="swatch" viewBox="0 0 56 16" width="56" height="16" aria-hidden="true" focusable="false">
      <line x1="4" y1="8" x2="52" y2="8" stroke={ROUTE_STYLES.samaan.colour} strokeWidth="6" strokeLinecap="round" />
      <line x1="4" y1="8" x2="52" y2="8" stroke={UNKNOWN_OVERLAY_COLOUR} strokeWidth="8" strokeDasharray="4 4" />
    </svg>
  );
}

export function BarrierRingSwatch() {
  return (
    <svg className="swatch" viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <circle cx="28" cy="12" r="10" fill="none" stroke="#b71c1c" strokeWidth="3" />
      <circle cx="28" cy="12" r="5" fill="#ef6c00" stroke="#fff" strokeWidth="1.5" />
    </svg>
  );
}
