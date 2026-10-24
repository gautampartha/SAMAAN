// Typed client for the SAMAAN API. The contract is owned by the Python API;
// treat the types below as fixed and extend them only when the API changes.
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from 'geojson';
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

export type ObservedBy = 'image' | 'wheel' | 'report';

export interface FootpathProps {
  id: number;
  kind: string;
  state: FootpathState;
  length_m: number;
  side: 'L' | 'R' | 'none';
  highway: string | null;
  synthetic: boolean;
  /** How the state was observed (P9); absent on older API builds. */
  observed_by?: ObservedBy | (string & {}) | null;
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

/** `suspected` = a jolt felt by wheelchair wheels that still needs a photo (P9). */
export type BarrierStatus = 'active' | 'fixed' | 'expired' | 'suspected';
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

export type LayerKey = 'footpaths' | 'barriers' | 'coverage' | 'anchors' | 'demo' | 'images' | 'wheels';
export const LAYER_KEYS: readonly LayerKey[] = ['footpaths', 'barriers', 'coverage', 'anchors', 'demo', 'images', 'wheels'] as const;

export interface LayerData {
  footpaths?: FootpathFC;
  barriers?: BarrierFC;
  coverage?: CoverageFC;
  anchors?: AnchorFC;
  demo?: DemoFC;
  images?: ImageFC;
  wheels?: WheelsFC;
}

export class ApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    /** The API's `{detail: "..."}` string when the error body carried one (e.g. "rate_limit", "gps_offset"). */
    public readonly detail: string | null = null,
  ) {
    super(`${path}: HTTP ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'ApiError';
  }
}

/** Read `{detail: string}` from an error body; anything else yields null. */
async function readDetail(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string') {
      return (body as { detail: string }).detail;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new ApiError(path, res.status, await readDetail(res));
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(path, res.status, await readDetail(res));
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
  wheels: (signal?: AbortSignal) => getJson<WheelsFC>('/layers/wheels', signal),
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

export type Profile = 'walker' | 'wheelchair_manual' | 'elderly_walking_aid' | 'pram' | 'cognitive' | 'blind_low_vision';
export const PROFILES: readonly Profile[] = ['walker', 'wheelchair_manual', 'elderly_walking_aid', 'pram', 'cognitive', 'blind_low_vision'] as const;
/** Profiles a traveller can pick (the walker is the comparison baseline, never selectable). */
export const SELECTABLE_PROFILES: readonly Profile[] = ['wheelchair_manual', 'elderly_walking_aid', 'pram', 'cognitive', 'blind_low_vision'] as const;
export type Risk = 'strict' | 'balanced' | 'relaxed';
export const RISKS: readonly Risk[] = ['strict', 'balanced', 'relaxed'] as const;
/** The two routes shown per trip. `naive_accessible` exists on the API (`&modes=all`) but is not used in the UI. */
export type RouteMode = 'standard' | 'samaan';
export const ROUTE_MODES: readonly RouteMode[] = ['standard', 'samaan'] as const;

// ---------- Profiles (GET /profiles) ----------

/** How a profile is served: MOVE (map + cards), EXPLORE (camera + arrow), LISTEN (voice), or the walker baseline. */
export type AppMode = 'move' | 'explore' | 'listen';
export type ProfileMode = AppMode | 'baseline';

export interface ProfileInfo {
  id: Profile;
  name_en: string;
  name_hi: string;
  description_en: string;
  description_hi: string;
  mode: ProfileMode;
  speed_m_s: number;
}

export interface ProfilesResponse {
  profiles: ProfileInfo[];
}

/** Used until `/profiles` answers (and when it never does): the same ids and modes as the API. */
export const FALLBACK_PROFILES: readonly ProfileInfo[] = [
  { id: 'wheelchair_manual', name_en: 'Manual wheelchair', name_hi: 'मैनुअल व्हीलचेयर', description_en: '', description_hi: '', mode: 'move', speed_m_s: 0.9 },
  { id: 'elderly_walking_aid', name_en: 'Elderly with walking aid', name_hi: 'छड़ी या वॉकर वाले बुज़ुर्ग', description_en: '', description_hi: '', mode: 'move', speed_m_s: 0.7 },
  { id: 'pram', name_en: 'Pram', name_hi: 'बच्चा-गाड़ी (प्रैम)', description_en: '', description_hi: '', mode: 'move', speed_m_s: 1.1 },
  { id: 'cognitive', name_en: 'Dyslexic or autistic', name_hi: 'डिस्लेक्सिया या ऑटिज़्म', description_en: '', description_hi: '', mode: 'explore', speed_m_s: 1.2 },
  { id: 'blind_low_vision', name_en: 'Blind or low vision', name_hi: 'दृष्टिहीन या कम दृष्टि', description_en: '', description_hi: '', mode: 'listen', speed_m_s: 0.9 },
] as const;

export const profileApi = {
  list: (signal?: AbortSignal) => getJson<ProfilesResponse>('/profiles', signal),
};

// ---------- Turn-by-turn steps and confidence ----------

export type StepType =
  | 'depart'
  | 'straight'
  | 'slight_left'
  | 'left'
  | 'sharp_left'
  | 'slight_right'
  | 'right'
  | 'sharp_right'
  | 'uturn'
  | 'cross'
  | 'arrive';

export interface StepWarning {
  class: BarrierClassId | ReportOnlyClassId | (string & {});
  name_en: string;
  name_hi: string;
  severity: Severity;
  impassable_for_profile: boolean;
}

export interface RouteStep {
  index: number;
  type: StepType | (string & {});
  instruction_en: string;
  instruction_hi: string;
  /** Metres from the previous step. */
  distance_m: number;
  /** Metres from the origin. */
  cumulative_m: number;
  /** [lon, lat] */
  location: [number, number];
  /** Direction of travel after the step, degrees clockwise from north. */
  bearing_deg: number;
  street_en: string | null;
  street_hi: string | null;
  warnings: StepWarning[];
  edge_ids: number[];
}

export type ConfidenceLabel = 'high' | 'medium' | 'low';

export interface RouteConfidence {
  /** 0-1 */
  score: number;
  label: ConfidenceLabel;
  factors: {
    verified_pct: number;
    median_image_age_days: number | null;
    barrier_confidence: number | null;
    unknown_pct: number;
    fresh_segments_pct: number;
  };
}

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
  confidence: RouteConfidence;
  segments_total: number;
  segments_no_recent_imagery: number;
  segments_no_recent_imagery_pct: number;
  steps: RouteStep[];
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
  routes: Record<RouteMode, RouteResult | null> & { naive_accessible?: RouteResult | null };
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

// ---------- P7 citizen loop: users, reports, votes, missions ----------

/** Classes a citizen can report but the detector does not emit. */
export type ReportOnlyClassId =
  | 'no_footpath'
  | 'footpath_end'
  | 'waterlogging'
  | 'construction'
  | 'lift_out_of_service'
  | 'foot_overbridge_stairs_only';

export type ReportClassId = BarrierClassId | ReportOnlyClassId;

export const BARRIER_CLASS_IDS: readonly BarrierClassId[] = [
  'steps_or_high_kerb',
  'parked_vehicle',
  'open_drain',
  'curb_ramp',
  'broken_surface',
  'fixed_obstacle',
  'vendor_encroachment',
  'bike_barrier',
] as const;

export const REPORT_ONLY_CLASS_IDS: readonly ReportOnlyClassId[] = [
  'no_footpath',
  'footpath_end',
  'waterlogging',
  'construction',
  'lift_out_of_service',
  'foot_overbridge_stairs_only',
] as const;

export const SEVERITIES: readonly Severity[] = [1, 2, 3, 4, 5] as const;

export interface User {
  id: number | string;
  display_name: string;
  /** 0-1 */
  trust_score: number;
  profile: Profile;
  language: Lang;
  n_reports?: number;
  n_votes?: number;
}

export interface NewUser {
  display_name: string;
  profile: Profile;
  language: Lang;
  /** Demo crew: starts trusted so one vote verifies (config reports.trust.team_initial). */
  team?: boolean;
}

export type ReportKind = 'barrier' | 'fixed';
export type ReportStatus = 'pending' | 'verified' | 'rejected' | 'fixed';
export type VoteValue = 'agree' | 'disagree' | 'unsure';
export const VOTE_VALUES: readonly VoteValue[] = ['agree', 'disagree', 'unsure'] as const;

export interface VoteCounts {
  agree: number;
  disagree: number;
  unsure: number;
}

export interface ReportTarget {
  id: number;
  class_id: ReportClassId | (string & {});
  name_en: string;
  name_hi: string;
  severity: Severity;
}

/** "Photograph this" on a jolt: the report sheet opens with the class and position filled in (P9). */
export interface ReportPrefill {
  class_id: ReportClassId | (string & {});
  lat: number;
  lon: number;
  name_en?: string;
  name_hi?: string;
  /** The suspected barrier the jolt created, when known. */
  barrier_id?: number;
}

export interface ReportItem {
  id: number;
  kind: ReportKind;
  status: ReportStatus;
  class_id: ReportClassId | (string & {});
  name_en: string;
  name_hi: string;
  severity: Severity;
  note: string | null;
  lat: number;
  lon: number;
  edge_id: number | null;
  side: 'L' | 'R' | 'none' | null;
  snap_confidence: number | null;
  model_prescreen_score: number | null;
  duplicate_of_barrier_id: number | null;
  barrier_id: number | null;
  target_barrier_id: number | null;
  /** Relative or absolute; use `photoUrl`. */
  photo_url: string | null;
  score: number;
  n_votes: number;
  votes: VoteCounts;
  my_vote: VoteValue | null;
  /** Present when `near_lat`/`near_lon` were passed. */
  distance_m?: number;
  user_id: number | string;
  created_at: string;
  target_barrier: ReportTarget | null;
}

export interface ReportList {
  count: number;
  results: ReportItem[];
}

export interface ReportInput {
  /** JPEG; strongly encouraged for barriers, required for `kind: 'fixed'`. */
  photo: Blob | null;
  user_id: number | string;
  class_id: ReportClassId;
  severity: Severity;
  note?: string;
  /** Barrier / photo position. */
  lat: number;
  lon: number;
  heading_deg?: number | null;
  pitch_deg?: number | null;
  hfov_deg?: number | null;
  captured_at?: string;
  /** The phone's position when submitting; the API rejects when > 50 m from lat/lon. */
  device_lat?: number;
  device_lon?: number;
  kind: ReportKind;
  target_barrier_id?: number;
}

export interface VoteResponse {
  report_id: number;
  status: ReportStatus;
  score: number;
  n_votes: number;
  votes: VoteCounts;
  /** True when the vote changed barriers/footpaths/routes server-side. */
  resolved: boolean;
  barrier_id: number | null;
  voter_trust_score: number;
}

export interface ReportQuery {
  status?: ReportStatus;
  near?: { lat: number; lon: number; radius_m: number } | null;
  user_id?: number | string;
  limit?: number;
}

export type MissionStatus = 'open' | 'done';

export interface MissionProps {
  id: number;
  rank: number;
  priority: number;
  n_routes: number;
  length_m: number;
  status: MissionStatus | (string & {});
  edge_ids: number[];
  name_en: string;
  name_hi: string;
  /** [lon, lat] */
  centroid: [number, number];
  synthetic: boolean;
}

export type MissionFC = FeatureCollection<LineString, MissionProps>;
export type MissionFeature = Feature<LineString, MissionProps>;

export interface MissionsRecompute {
  missions: unknown;
  routes_sampled?: number;
  [key: string]: unknown;
}

export const userApi = {
  create: (input: NewUser, signal?: AbortSignal) => postJson<User>('/users', input, signal),
  get: (id: number | string, signal?: AbortSignal) => getJson<User>(`/users/${encodeURIComponent(String(id))}`, signal),
};

export const reportApi = {
  create: async (input: ReportInput, signal?: AbortSignal): Promise<ReportItem> => {
    const fd = new FormData();
    if (input.photo) fd.append('photo', input.photo, `report-${Date.now()}.jpg`);
    fd.append('user_id', String(input.user_id));
    fd.append('class_id', input.class_id);
    fd.append('severity', String(input.severity));
    if (input.note && input.note.trim()) fd.append('note', input.note.trim());
    fd.append('lat', String(input.lat));
    fd.append('lon', String(input.lon));
    if (typeof input.heading_deg === 'number') fd.append('heading_deg', String(input.heading_deg));
    if (typeof input.pitch_deg === 'number') fd.append('pitch_deg', String(input.pitch_deg));
    if (typeof input.hfov_deg === 'number') fd.append('hfov_deg', String(input.hfov_deg));
    if (input.captured_at) fd.append('captured_at', input.captured_at);
    if (typeof input.device_lat === 'number' && typeof input.device_lon === 'number') {
      fd.append('device_lat', String(input.device_lat));
      fd.append('device_lon', String(input.device_lon));
    }
    fd.append('kind', input.kind);
    if (input.kind === 'fixed' && typeof input.target_barrier_id === 'number') {
      fd.append('target_barrier_id', String(input.target_barrier_id));
    }
    const res = await fetch(`${API_URL}/reports`, { method: 'POST', body: fd, signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new ApiError('/reports', res.status, await readDetail(res));
    return (await res.json()) as ReportItem;
  },
  list: (query: ReportQuery, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    q.set('status', query.status ?? 'pending');
    if (query.near) {
      q.set('near_lat', String(query.near.lat));
      q.set('near_lon', String(query.near.lon));
      q.set('radius_m', String(query.near.radius_m));
    }
    if (query.user_id !== undefined) q.set('user_id', String(query.user_id));
    q.set('limit', String(query.limit ?? 20));
    return getJson<ReportList>(`/reports?${q.toString()}`, signal);
  },
  get: (id: number, signal?: AbortSignal) => getJson<ReportItem>(`/reports/${id}`, signal),
  vote: (reportId: number, userId: number | string, value: VoteValue, signal?: AbortSignal) =>
    postJson<VoteResponse>(`/reports/${reportId}/votes`, { user_id: userId, value }, signal),
};

export const missionApi = {
  list: (limit = 10, signal?: AbortSignal) => getJson<MissionFC>(`/missions?limit=${limit}`, signal),
  recompute: async (signal?: AbortSignal): Promise<MissionsRecompute> => {
    const res = await fetch(`${API_URL}/missions/recompute`, { method: 'POST', signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new ApiError('/missions/recompute', res.status, await readDetail(res));
    return (await res.json()) as MissionsRecompute;
  },
};

// ---------- P8 Reach Gap (GET /reach/anchors, GET /reach) ----------

/** The walker is the comparison baseline, so it is not a selectable target profile. */
export type ReachProfile = Exclude<Profile, 'walker'>;
export const REACH_PROFILES: readonly ReachProfile[] = ['wheelchair_manual', 'elderly_walking_aid', 'pram'] as const;
export const REACH_CUTOFFS = [5, 10, 15] as const;
export type ReachCutoff = (typeof REACH_CUTOFFS)[number];

export interface ReachAnchor {
  id: number | string;
  kind: AnchorKind | (string & {});
  name_en: string;
  name_hi: string;
  lat: number;
  lon: number;
  verified: boolean;
}

export interface ReachAnchorsResponse {
  anchors: ReachAnchor[];
}

export interface ReachResult {
  profile: Profile;
  /** Footpath length reachable within the cutoff (network distance), in km. */
  reach_km: number;
  n_edges: number;
  /** WGS84 hull of the reachable footpaths; null when nothing is reachable. */
  hull: Polygon | MultiPolygon | null;
  edge_ids: number[];
}

export interface ReachFixBarrier {
  id: number;
  class: BarrierClassId | (string & {});
  name_en: string;
  name_hi: string;
  severity: Severity;
  lat: number;
  lon: number;
  edge_id: number;
  permanent: boolean;
  synthetic: boolean;
}

export interface ReachFix {
  rank: number;
  barrier: ReachFixBarrier;
  /** Reach gained when this fix is applied after the previous ones. */
  gain_km: number;
  cumulative_reach_km: number;
  cost_lakh_min: number | null;
  cost_lakh_max: number | null;
  gain_km_per_lakh: number | null;
  cost_is_estimate: boolean;
  cost_source: string;
}

export interface ReachResponse {
  anchor: { id: number | string; name_en: string; name_hi: string; lat: number; lon: number };
  cutoff_min: number;
  risk: Risk;
  profile: Profile;
  synthetic_overlay: boolean;
  walker: ReachResult;
  target: ReachResult;
  gap_km: number;
  /** target / walker, 0-1; null when the walker reaches nothing. */
  ratio: number | null;
  /** Ranked, up to 5. */
  fixes: ReachFix[];
  /** The target profile's reach with the `fixed` barriers treated as fixed; null unless `fixed` was sent. */
  simulated: ReachResult | null;
  simulated_gap_km: number | null;
}

export interface ReachParams {
  anchor: number | string;
  profile: ReachProfile;
  cutoff_min: ReachCutoff;
  risk: Risk;
  /** Barrier ids to simulate as fixed (omitted when empty). */
  fixed?: number[];
}

// ---------- P9 wheels as sensors (POST /rides, GET /layers/wheels) ----------

export type RideStatus = 'active' | 'ended' | 'processed';

export interface Ride {
  id: number | string;
  user_id: number | string;
  started_at: string;
  status: RideStatus;
}

export interface NewRide {
  user_id: number | string;
  /** ISO 8601. */
  started_at: string;
  device?: string;
  sample_rate_hz?: number;
}

/** One accelerometer sample; a sample that carries `lat`/`lon` is also a GPS fix. */
export interface RideSample {
  /** Seconds since ride start. */
  t: number;
  /** m/s², device frame, including gravity. */
  ax: number;
  ay: number;
  az: number;
  lat?: number;
  lon?: number;
  gps_accuracy_m?: number;
  speed_m_s?: number;
}

export interface SamplesAccepted {
  accepted: number;
  total: number;
}

export interface RideRoughness {
  edge_id: number;
  /** m/s² */
  roughness_index: number;
  n_windows: number;
}

export interface RideSummary {
  id: number | string;
  status: RideStatus;
  duration_s: number;
  n_samples: number;
  n_windows: number;
  n_matched_windows: number;
  edges_traversed: number;
  edges_verified_by_wheels: number;
  jolts: number;
  verified_edge_ids: number[];
  jolt_barrier_ids: number[];
  roughness: RideRoughness[];
  synthetic: boolean;
}

export interface WheelsEdgeProps {
  edge_id: number;
  /** m/s²; null when no window matched. */
  roughness_index: number | null;
  n_traversals: number;
  verified_by_wheels: boolean;
  last_traversed_at: string | null;
  synthetic: boolean;
}

export interface WheelsJoltProps {
  kind: 'jolt';
  barrier_id: number;
  class: BarrierClassId | (string & {});
  name_en: string;
  name_hi: string;
  /** m/s² */
  peak_m_s2: number;
  status: 'suspected' | (string & {});
  synthetic: boolean;
}

export type WheelsFC = FeatureCollection<LineString | Point, WheelsEdgeProps | WheelsJoltProps>;
export type WheelsEdgeFeature = Feature<LineString, WheelsEdgeProps>;
export type WheelsJoltFeature = Feature<Point, WheelsJoltProps>;

export function isJoltFeature(f: Feature<LineString | Point, WheelsEdgeProps | WheelsJoltProps>): f is WheelsJoltFeature {
  return f.geometry.type === 'Point' && (f.properties as { kind?: unknown }).kind === 'jolt';
}

export function isWheelsEdgeFeature(f: Feature<LineString | Point, WheelsEdgeProps | WheelsJoltProps>): f is WheelsEdgeFeature {
  return f.geometry.type === 'LineString';
}

const rideId = (id: number | string) => encodeURIComponent(String(id));

export const rideApi = {
  create: (input: NewRide, signal?: AbortSignal) => postJson<Ride>('/rides', input, signal),
  samples: (id: number | string, samples: RideSample[], signal?: AbortSignal) =>
    postJson<SamplesAccepted>(`/rides/${rideId(id)}/samples`, { samples }, signal),
  end: (id: number | string, ended_at: string, signal?: AbortSignal) => postJson<RideSummary>(`/rides/${rideId(id)}/end`, { ended_at }, signal),
  get: (id: number | string, signal?: AbortSignal) => getJson<RideSummary>(`/rides/${rideId(id)}`, signal),
  replayDemo: (user_id: number | string, signal?: AbortSignal) => postJson<RideSummary>('/rides/replay-demo', { user_id }, signal),
};

export const reachApi = {
  anchors: (signal?: AbortSignal) => getJson<ReachAnchorsResponse>('/reach/anchors', signal),
  reach: (params: ReachParams, signal?: AbortSignal) => {
    const q = new URLSearchParams({
      anchor: String(params.anchor),
      profile: params.profile,
      cutoff_min: String(params.cutoff_min),
      risk: params.risk,
    });
    if (params.fixed && params.fixed.length > 0) q.set('fixed', params.fixed.join(','));
    return getJson<ReachResponse>(`/reach?${q.toString()}`, signal);
  },
};

// ---------- Demo mode (GET /demo/status, POST /demo/reset) ----------

export interface DemoCounts {
  images?: { total: number; real: number; synthetic: number; mapillary: number; own_photo: number };
  barriers?: { total: number; real: number; synthetic: number; active: number };
  coverage?: { edges_total: number; edges_known_real: number; edges_known_any: number; pct_real: number; pct_any: number };
  reports?: { pending: number; verified: number; rejected: number; fixed: number };
  votes?: number;
  users?: number;
  rides?: number;
  missions?: number;
  zone?: { name: string; display_name: LocalizedName | string };
  synthetic_present?: boolean;
}

export interface DemoReset extends Omit<DemoCounts, 'status'> {
  status?: string;
  deleted?: Record<string, number>;
  recompute?: unknown;
}

export const demoApi = {
  status: (signal?: AbortSignal) => getJson<DemoCounts>('/demo/status', signal),
  reset: async (signal?: AbortSignal): Promise<DemoReset> => {
    const res = await fetch(`${API_URL}/demo/reset`, { method: 'POST', signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new ApiError('/demo/reset', res.status, await readDetail(res));
    return (await res.json()) as DemoReset;
  },
};

// ---------- Voice agent (GET /voice/config) ----------

export interface VoiceConfig {
  enabled: boolean;
  provider: 'vapi' | null;
  public_key: string | null;
  /** Pre-created assistant (set when the public key forbids transient assistants). */
  assistant_id?: string | null;
  tools: string[];
}

export const voiceApi = {
  config: (signal?: AbortSignal) => getJson<VoiceConfig>('/voice/config', signal),
};
