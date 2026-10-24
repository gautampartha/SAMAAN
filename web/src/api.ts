// Typed client for the SAMAAN API. The contract is owned by the Python API;
// treat the types below as fixed and extend them only when the API changes.
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { Lang } from './i18n';

const rawBase = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
export const API_URL: string = (rawBase && rawBase.length > 0 ? rawBase : 'http://127.0.0.1:8000').replace(/\/+$/, '');

export interface LocalizedName {
  en: string;
  hi: string;
}

export interface Health {
  status: string;
  zone: string;
  synthetic: boolean;
}

export interface Zone {
  name: string;
  display_name: LocalizedName;
  bbox: { south: number; west: number; north: number; east: number };
  center: { lat: number; lon: number };
  basemap: { style_url: string; attribution: string };
  attribution: { osm: string };
}

export type FootpathState = 'clear' | 'blocked' | 'unknown';

export interface FootpathProps {
  id: number;
  kind: string;
  state: FootpathState;
  length_m: number;
  side: 'L' | 'R' | 'none';
  highway: string | null;
  synthetic: boolean;
}

export type BarrierClassId =
  | 'steps_or_high_kerb'
  | 'parked_vehicle'
  | 'open_drain'
  | 'curb_ramp'
  | 'broken_surface'
  | 'fixed_obstacle'
  | 'vendor_encroachment'
  | 'bike_barrier';

export type BarrierStatus = 'active' | 'fixed' | 'expired';
export type Severity = 1 | 2 | 3 | 4 | 5;

export interface BarrierProps {
  id: number;
  // Known ids are listed; the API may add more, so keep the string fallback.
  class: BarrierClassId | (string & {});
  name_en: string;
  name_hi: string;
  severity: Severity;
  tags: string[];
  permanent: boolean;
  status: BarrierStatus;
  confidence: number;
  edge_id: number;
  synthetic: boolean;
}

export interface CoverageProps {
  edge_id: number;
  observed: boolean;
  n_images: number;
  last_observed_at: string | null;
}

export type AnchorKind = 'metro' | 'bus_stop' | 'hospital' | 'school';

export interface AnchorProps {
  id: number;
  kind: AnchorKind;
  name_en: string;
  name_hi: string;
  verified: boolean;
  synthetic: boolean;
}

export type DemoProps =
  | { role: 'origin'; synthetic?: boolean }
  | { role: 'destination'; name_en: string; name_hi: string; synthetic?: boolean }
  | { role: 'path'; length_m: number; synthetic?: boolean };

export type FootpathFC = FeatureCollection<LineString, FootpathProps>;
export type BarrierFC = FeatureCollection<Point, BarrierProps>;
export type CoverageFC = FeatureCollection<LineString, CoverageProps>;
export type AnchorFC = FeatureCollection<Point, AnchorProps>;
export type DemoFC = FeatureCollection<Point | LineString, DemoProps>;
export type BarrierFeature = Feature<Point, BarrierProps>;

export type LayerKey = 'footpaths' | 'barriers' | 'coverage' | 'anchors' | 'demo';
export const LAYER_KEYS: readonly LayerKey[] = ['footpaths', 'barriers', 'coverage', 'anchors', 'demo'] as const;

export interface LayerData {
  footpaths?: FootpathFC;
  barriers?: BarrierFC;
  coverage?: CoverageFC;
  anchors?: AnchorFC;
  demo?: DemoFC;
}

export class ApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
  ) {
    super(`${path}: HTTP ${status}`);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new ApiError(path, res.status);
  return (await res.json()) as T;
}

export const api = {
  health: (signal?: AbortSignal) => getJson<Health>('/health', signal),
  zone: (signal?: AbortSignal) => getJson<Zone>('/zone', signal),
  footpaths: (signal?: AbortSignal) => getJson<FootpathFC>('/layers/footpaths', signal),
  barriers: (signal?: AbortSignal) => getJson<BarrierFC>('/layers/barriers', signal),
  coverage: (signal?: AbortSignal) => getJson<CoverageFC>('/layers/coverage', signal),
  anchors: (signal?: AbortSignal) => getJson<AnchorFC>('/layers/anchors', signal),
  demo: (signal?: AbortSignal) => getJson<DemoFC>('/layers/demo', signal),
};

/** Pick the name in the current language, falling back to English. */
export function localizedName(props: { name_en: string; name_hi?: string | null }, lang: Lang): string {
  if (lang === 'hi' && props.name_hi) return props.name_hi;
  return props.name_en;
}

/** Pick a {en, hi} display name in the current language. */
export function localized(name: LocalizedName, lang: Lang): string {
  return (lang === 'hi' && name.hi) || name.en;
}
