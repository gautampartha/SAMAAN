// State and actions for the trip planner (origin/destination, profile, risk,
// departure time, the /route result with its two routes and the selected card).
// Lives outside the components so the map, the Home sheet, the route choice and
// the navigation engine share one source of truth.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  FALLBACK_PROFILES,
  PROFILES,
  RISKS,
  profileApi,
  routeApi,
  type Profile,
  type ProfileInfo,
  type Risk,
  type RouteMode,
  type RouteResponse,
} from './api';

export const PROFILE_KEY = 'samaan.route.profile';
export const RISK_KEY = 'samaan.route.risk';

export type PointRole = 'origin' | 'destination';

export interface PlannerPoint {
  lat: number;
  lon: number;
  /** Display label: a place name, "My location" or formatted coordinates. */
  label: string;
}

export type RouteErrorKind = 'tooFar' | 'demoUnknown' | 'badParams' | 'generic';

export interface PlannerState {
  origin: PlannerPoint | null;
  destination: PlannerPoint | null;
  pickMode: PointRole | null;
  profile: Profile;
  /** Profiles from `GET /profiles` (the fallback list until it answers). Never includes the walker baseline. */
  profiles: ProfileInfo[];
  profilesFromApi: boolean;
  risk: Risk;
  /** HH:MM in local time. */
  time: string;
  loading: boolean;
  error: RouteErrorKind | null;
  result: RouteResponse | null;
  selected: RouteMode | null;
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Current local time as HH:MM for `<input type="time">`. */
export function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Today's date at HH:MM as an ISO datetime WITH the local offset, so the API sees the local hour. */
export function departIso(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  const d = new Date();
  if (m) {
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${offset}`;
}

export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function classifyError(err: unknown, demo: boolean): RouteErrorKind {
  if (err instanceof ApiError) {
    if (err.status === 404) return demo ? 'demoUnknown' : 'tooFar';
    if (err.status === 422) return 'badParams';
  }
  return 'generic';
}

export function useRoutePlanner() {
  const [origin, setOrigin] = useState<PlannerPoint | null>(null);
  const [destination, setDestination] = useState<PlannerPoint | null>(null);
  const [pickMode, setPickMode] = useState<PointRole | null>(null);
  const [profile, setProfileState] = useState<Profile>(() => readStored(PROFILE_KEY, PROFILES, 'wheelchair_manual'));
  const [profiles, setProfiles] = useState<ProfileInfo[]>([...FALLBACK_PROFILES]);
  const [profilesFromApi, setProfilesFromApi] = useState(false);
  const [risk, setRiskState] = useState<Risk>(() => readStored(RISK_KEY, RISKS, 'balanced'));
  const [time, setTime] = useState<string>(nowHHMM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<RouteErrorKind | null>(null);
  const [result, setResult] = useState<RouteResponse | null>(null);
  const [selected, setSelected] = useState<RouteMode | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  /** The last request, so the comparison can be re-run after the map changed (a resolved vote). */
  const lastRef = useRef<{ fetcher: (signal: AbortSignal) => Promise<RouteResponse>; demo: boolean } | null>(null);

  useEffect(() => writeStored(PROFILE_KEY, profile), [profile]);
  useEffect(() => writeStored(RISK_KEY, risk), [risk]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // GET /profiles once; the fallback list stays when the API is down. Walker (baseline) is never selectable.
  useEffect(() => {
    const ac = new AbortController();
    profileApi
      .list(ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        const list = res.profiles.filter((p) => p.mode !== 'baseline' && p.id !== 'walker');
        if (list.length > 0) {
          setProfiles(list);
          setProfilesFromApi(true);
        }
      })
      .catch((err: unknown) => {
        if (!ac.signal.aborted) console.warn('[profiles]', err);
      });
    return () => ac.abort();
  }, []);

  const setProfile = useCallback((p: Profile) => setProfileState(p), []);
  const setRisk = useCallback((r: Risk) => setRiskState(r), []);

  const setPoint = useCallback((role: PointRole, point: PlannerPoint | null) => {
    if (role === 'origin') setOrigin(point);
    else setDestination(point);
    setPickMode(null);
  }, []);

  const togglePick = useCallback((role: PointRole) => {
    setPickMode((cur) => (cur === role ? null : role));
  }, []);

  const run = useCallback(
    async (fetcher: (signal: AbortSignal) => Promise<RouteResponse>, demo: boolean, keepSelection = false) => {
      if (loadingRef.current) return; // one request at a time; buttons stay enabled so focus is not lost
      loadingRef.current = true;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      lastRef.current = { fetcher, demo };
      setLoading(true);
      setError(null);
      try {
        const res = await fetcher(ac.signal);
        if (ac.signal.aborted) return;
        setResult(res);
        // Highlight SAMAAN's route; fall back to the standard one. A re-run keeps the user's pick.
        const fallback: RouteMode | null = res.routes.samaan ? 'samaan' : res.routes.standard ? 'standard' : null;
        setSelected((cur) => (keepSelection && cur && res.routes[cur] ? cur : fallback));
        if (demo) {
          setOrigin({ lat: res.origin.lat, lon: res.origin.lon, label: formatCoords(res.origin.lat, res.origin.lon) });
          setDestination({
            lat: res.destination.lat,
            lon: res.destination.lon,
            label: formatCoords(res.destination.lat, res.destination.lon),
          });
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        console.warn('[route]', err);
        setError(classifyError(err, demo));
      } finally {
        loadingRef.current = false;
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [],
  );

  /** Routes between the current origin and destination (no-op until both are set). */
  const compare = useCallback(() => {
    if (!origin || !destination) return;
    const params = { profile, risk, depart: departIso(time) };
    void run((signal) => routeApi.between(origin, destination, params, signal), false);
  }, [origin, destination, profile, risk, time, run]);

  /** Routes between two explicit points (sets them too), e.g. "My location" resolved a moment ago. */
  const compareBetween = useCallback(
    (from: PlannerPoint, to: PlannerPoint) => {
      setOrigin(from);
      setDestination(to);
      const params = { profile, risk, depart: departIso(time) };
      void run((signal) => routeApi.between(from, to, params, signal), false);
    },
    [profile, risk, time, run],
  );

  const runDemo = useCallback(() => {
    const params = { profile, risk, depart: departIso(time) };
    void run((signal) => routeApi.demo('riya', params, signal), true);
  }, [profile, risk, time, run]);

  /** Re-run the last comparison (after a resolved vote changed barriers/footpaths). No-op without one. */
  const rerun = useCallback(() => {
    const last = lastRef.current;
    if (!last) return;
    void run(last.fetcher, last.demo, true);
  }, [run]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    loadingRef.current = false;
    lastRef.current = null;
    setResult(null);
    setSelected(null);
    setError(null);
    setLoading(false);
  }, []);

  const state: PlannerState = {
    origin,
    destination,
    pickMode,
    profile,
    profiles,
    profilesFromApi,
    risk,
    time,
    loading,
    error,
    result,
    selected,
  };

  return {
    state,
    setPoint,
    togglePick,
    setPickMode,
    setProfile,
    setRisk,
    setTime,
    compare,
    compareBetween,
    runDemo,
    rerun,
    clear,
    select: setSelected,
  };
}

export type RoutePlannerApi = ReturnType<typeof useRoutePlanner>;
