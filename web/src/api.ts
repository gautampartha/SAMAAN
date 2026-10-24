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
  /** Optional; relative URLs (prefix with API_URL via `photoUrl`). Absent on older API builds. */
  photo_urls?: string[];
}

export type CoverageSource = 'image' | 'seed' | 'wheel' | 'report';

export interface CoverageProps {
  edge_id: number;
  observed: boolean;
  n_images: number;
  last_observed_at: string | null;
  side: 'L' | 'R' | 'none';
  source: CoverageSource | (string & {});
}

export type ImageSource = 'mapillary' | 'own' | 'report';

export interface ImageProps {
  id: number | string;
  source: ImageSource | (string & {});
  heading_deg: number | null;
  hfov_deg: number;
  captured_at: string | null;
  attribution: string | null;
  synthetic: boolean;
  session_id: string | null;
  has_photo: boolean;
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
export type ImageFC = FeatureCollection<Point, ImageProps>;
export type BarrierFeature = Feature<Point, BarrierProps>;

export type LayerKey = 'footpaths' | 'barriers' | 'coverage' | 'anchors' | 'demo' | 'images';
export const LAYER_KEYS: readonly LayerKey[] = ['footpaths', 'barriers', 'coverage', 'anchors', 'demo', 'images'] as const;

export interface LayerData {
  footpaths?: FootpathFC;
  barriers?: BarrierFC;
  coverage?: CoverageFC;
  anchors?: AnchorFC;
  demo?: DemoFC;
  images?: ImageFC;
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
  images: (signal?: AbortSignal) => getJson<ImageFC>('/layers/images', signal),
};

/** URL of the stored photo for an image feature (`has_photo` must be true). */
export function imagePhotoUrl(id: number | string): string {
  return `${API_URL}/images/${encodeURIComponent(String(id))}/photo`;
}

// ---------- Capture uploads (multipart POST /images) ----------

export type HeadingSource = 'absolute' | 'relative' | 'none';

/** One photo taken on a walk, as sent to `POST /images`. */
export interface CaptureUpload {
  blob: Blob;
  lat: number;
  lon: number;
  gps_accuracy_m: number;
  heading_deg: number | null;
  pitch_deg: number | null;
  hfov_deg: number;
  /** ISO 8601 timestamp of the capture. */
  captured_at: string;
  session_id: string;
  note: string;
  width: number;
  height: number;
  heading_source: HeadingSource;
}

export interface UploadedImage {
  id: number | string;
  [key: string]: unknown;
}

export async function uploadImage(rec: CaptureUpload, signal?: AbortSignal): Promise<UploadedImage> {
  const fd = new FormData();
  const ts = Number.isFinite(Date.parse(rec.captured_at)) ? Date.parse(rec.captured_at) : Date.now();
  fd.append('photo', rec.blob, `${ts}.jpg`);
  fd.append('source', 'own');
  fd.append('lat', String(rec.lat));
  fd.append('lon', String(rec.lon));
  fd.append('gps_accuracy_m', String(rec.gps_accuracy_m));
  if (rec.heading_deg !== null) fd.append('heading_deg', String(rec.heading_deg));
  if (rec.pitch_deg !== null) fd.append('pitch_deg', String(rec.pitch_deg));
  fd.append('hfov_deg', String(rec.hfov_deg));
  fd.append('captured_at', rec.captured_at);
  fd.append('session_id', rec.session_id);
  fd.append('note', rec.note);
  fd.append('width', String(rec.width));
  fd.append('height', String(rec.height));
  fd.append('heading_source', rec.heading_source);
  const res = await fetch(`${API_URL}/images`, { method: 'POST', body: fd, signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ApiError('/images', res.status);
  return (await res.json()) as UploadedImage;
}

/** Ask the API to recompute coverage after uploads. Errors are the caller's to ignore. */
export async function recomputeCoverage(signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API_URL}/coverage/recompute`, { method: 'POST', signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ApiError('/coverage/recompute', res.status);
}

// ---------- Route planner (GET /route, GET /search) ----------

export type Profile = 'walker' | 'wheelchair_manual' | 'elderly_walking_aid' | 'pram';
export const PROFILES: readonly Profile[] = ['walker', 'wheelchair_manual', 'elderly_walking_aid', 'pram'] as const;
export type Risk = 'strict' | 'balanced' | 'relaxed';
export const RISKS: readonly Risk[] = ['strict', 'balanced', 'relaxed'] as const;
export type RouteMode = 'shortest' | 'naive_accessible' | 'samaan';
export const ROUTE_MODES: readonly RouteMode[] = ['shortest', 'naive_accessible', 'samaan'] as const;

export interface RouteBarrier {
  id: number;
  class: BarrierClassId | (string & {});
  name_en: string;
  name_hi: string;
  severity: Severity;
  permanent: boolean;
  lat: number;
  lon: number;
  edge_id: number;
  confidence: number;
  tags: string[];
  synthetic: boolean;
  /** Probability the barrier is present at the departure hour (0-1). */
  p_present: number;
  impassable_for_profile: boolean;
  /** Relative URLs; prefix with API_URL via `photoUrl`. */
  photo_urls: string[];
}

export interface UnknownStretch {
  start: [number, number];
  end: [number, number];
  length_m: number;
  edge_ids: number[];
}

export interface RouteResult {
  mode: RouteMode;
  profile: Profile;
  risk: Risk | null;
  geometry: LineString;
  length_m: number;
  eta_s: number;
  eta_min: number;
  n_edges: number;
  edge_ids: number[];
  verified_pct: number;
  unknown_pct: number;
  blocked_pct: number;
  barriers: RouteBarrier[];
  n_barriers: number;
  n_barriers_impassable: number;
  unknown_stretches: UnknownStretch[];
  n_unknown_stretches: number;
  synthetic: boolean;
}

export interface RoutePoint {
  lat: number;
  lon: number;
  snap_distance_m?: number;
}

export interface RouteResponse {
  profile: Profile;
  risk: Risk;
  departure_hour: number;
  origin_node: number;
  destination_node: number;
  synthetic_overlay: boolean;
  origin: RoutePoint;
  destination: RoutePoint;
  demo?: 'riya';
  label_en?: string;
  label_hi?: string;
  routes: Record<RouteMode, RouteResult | null>;
}

export interface RouteParams {
  profile: Profile;
  risk: Risk;
  /** ISO datetime; only the hour matters to the API. */
  depart: string;
}

export type SearchKind = 'anchor' | 'place' | 'street' | 'demo';

export interface SearchResult {
  id: number | string;
  name_en: string;
  name_hi: string;
  kind: SearchKind | (string & {});
  lat: number;
  lon: number;
  subtitle_en?: string;
  subtitle_hi?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

function routeQuery(params: RouteParams): URLSearchParams {
  return new URLSearchParams({ profile: params.profile, risk: params.risk, depart: params.depart });
}

export const routeApi = {
  between: (from: { lat: number; lon: number }, to: { lat: number; lon: number }, params: RouteParams, signal?: AbortSignal) => {
    const q = routeQuery(params);
    q.set('from_lat', String(from.lat));
    q.set('from_lon', String(from.lon));
    q.set('to_lat', String(to.lat));
    q.set('to_lon', String(to.lon));
    return getJson<RouteResponse>(`/route?${q.toString()}`, signal);
  },
  demo: (name: 'riya', params: RouteParams, signal?: AbortSignal) => {
    const q = routeQuery(params);
    q.set('demo', name);
    return getJson<RouteResponse>(`/route?${q.toString()}`, signal);
  },
  search: (query: string, limit = 8, signal?: AbortSignal) => {
    const q = new URLSearchParams({ q: query, limit: String(limit) });
    return getJson<SearchResponse>(`/search?${q.toString()}`, signal);
  },
};

/** Absolute URL for a photo path returned by the API (already-absolute URLs pass through). */
export function photoUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Pick the name in the current language, falling back to English. */
export function localizedName(props: { name_en: string; name_hi?: string | null }, lang: Lang): string {
  if (lang === 'hi' && props.name_hi) return props.name_hi;
  return props.name_en;
}

/** Pick a {en, hi} display name in the current language. */
export function localized(name: LocalizedName, lang: Lang): string {
  return (lang === 'hi' && name.hi) || name.en;
}
