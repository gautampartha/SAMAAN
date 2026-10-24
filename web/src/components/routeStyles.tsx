// Visual identity of the two compared routes. Shared by the map layers, the
// legend and the route cards so they always agree. The styles differ in width
// AND dash pattern, so routes are told apart without colour: SAMAAN is a thick
// solid blue line with a white casing, the standard route a thinner dashed grey one.
import type { RouteMode } from '../api';

export interface RouteStyle {
  colour: string;
  width: number;
  /** MapLibre `line-dasharray` (in line-width units); undefined = solid. */
  dash?: [number, number];
  /** SVG `stroke-dasharray` for the legend / card swatch. */
  svgDash?: string;
  casing: boolean;
  /** Digit shown in sr-only summaries. */
  index: 1 | 2;
}

export const ROUTE_PRIMARY = '#1561f1';

export const ROUTE_STYLES: Record<RouteMode, RouteStyle> = {
  standard: { colour: '#5f6368', width: 4, dash: [2, 1.5], svgDash: '8 6', casing: true, index: 1 },
  samaan: { colour: ROUTE_PRIMARY, width: 7, casing: true, index: 2 },
};

export const ROUTE_ENDPOINT_COLOURS = { origin: '#111111', destination: ROUTE_PRIMARY } as const;
export const UNKNOWN_OVERLAY_COLOUR = '#424242';
export const USER_DOT_COLOUR = ROUTE_PRIMARY;

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

export function UserDotSwatch() {
  return (
    <svg className="swatch" viewBox="0 0 56 24" width="56" height="24" aria-hidden="true" focusable="false">
      <circle cx="18" cy="12" r="10" fill={USER_DOT_COLOUR} fillOpacity="0.2" />
      <circle cx="18" cy="12" r="6" fill={USER_DOT_COLOUR} stroke="#fff" strokeWidth="2.5" />
      <circle cx="42" cy="12" r="6" fill="#ffffff" stroke={USER_DOT_COLOUR} strokeWidth="2.5" />
    </svg>
  );
}
