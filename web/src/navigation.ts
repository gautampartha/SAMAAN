// Turn-by-turn engine shared by Navigate (Move), Explore and Listen. One hook
// instance lives in App so switching between the three screens keeps the trip.
//
// Position comes from GPS (`useSensors().fix`) or from the simulated walk, which
// moves a point along the route at a chosen speed (1 m/s by default, clearly
// labelled as simulation; it never feeds the photo contribution). The current
// step is the first step whose location is more than STEP_AHEAD_M ahead, along
// the route, of the user's projected position; each new step is announced once.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RouteMode, RouteResult, RouteStep } from './api';
import { bearingAlong, pointAlong, project, toPolyline, type LatLon, type Polyline, type Projection } from './geo';
import { setLastConfidence } from './mode';
import type { Sensors } from './sensors';

export const STEP_AHEAD_M = 8;
export const ARRIVE_M = 8;
export const OFF_ROUTE_M = 50;
export const GPS_WAIT_MS = 8000;
export const SIM_SPEEDS = [1, 5, 20] as const;
export type SimSpeed = (typeof SIM_SPEEDS)[number];
const SIM_TICK_MS = 500;

export interface NavPosition extends LatLon {
  /** Degrees clockwise from north; null when unknown. */
  heading: number | null;
  accuracy: number | null;
  simulated: boolean;
  ts: number;
}

export type GpsStatus = 'waiting' | 'ok' | 'error' | 'unsupported';

export interface NavSession {
  route: RouteResult;
  mode: RouteMode;
  line: Polyline;
  /** Metres along the route of each step. */
  stepAlong: number[];
  startedAt: number;
  /** Photos are contributed only when this was on at start (and only from real GPS fixes). */
  contribute: boolean;
}

export type AnnouncementKind = 'start' | 'step' | 'arrive';

export interface Announcement {
  /** Increments on every announcement so consumers can react once per id. */
  id: number;
  kind: AnnouncementKind;
  step: RouteStep | null;
  /** Metres along the route from the user to the step (for "In 120 m, ..."). */
  distance: number;
}

export interface NavState {
  session: NavSession | null;
  position: NavPosition | null;
  projection: Projection | null;
  /** Index into `route.steps` of the step being approached. */
  currentIndex: number;
  currentStep: RouteStep | null;
  /** Metres along the route to the current step. */
  distanceToStep: number;
  remainingM: number;
  /** 0-1 fraction of the route length walked. */
  progress: number;
  etaMs: number;
  offRoute: boolean;
  arrived: boolean;
  gps: GpsStatus;
  simulating: boolean;
  simSpeed: SimSpeed;
  /** True when there is no usable position: show the "Simulate walk" offer. */
  needsSimulation: boolean;
  announcement: Announcement | null;
}

export interface NavigationApi {
  state: NavState;
  start: (route: RouteResult, mode: RouteMode, contribute: boolean) => void;
  stop: () => void;
  startSimulation: () => void;
  stopSimulation: () => void;
  setSimSpeed: (speed: SimSpeed) => void;
  /** Re-emit the current step (double tap / "repeat"). */
  repeat: () => void;
}

/** Metres along the route of each step, monotonic. Uses the API's cumulative_m, corrected by projection when they agree. */
function stepDistances(line: Polyline, steps: RouteStep[]): number[] {
  const out: number[] = [];
  let last = 0;
  for (const s of steps) {
    const [lon, lat] = s.location;
    const p = project(line, { lat, lon });
    const cum = Number.isFinite(s.cumulative_m) ? s.cumulative_m : p.along;
    // The projection can snap to the wrong place on routes that pass near themselves; trust it only close to cumulative_m.
    let along = Math.abs(p.along - cum) <= 30 ? p.along : cum;
    if (along < last) along = last;
    out.push(along);
    last = along;
  }
  return out;
}

export function useNavigation(sensors: Sensors): NavigationApi {
  const [session, setSession] = useState<NavSession | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simSpeed, setSimSpeedState] = useState<SimSpeed>(1);
  const [simPos, setSimPos] = useState<NavPosition | null>(null);
  const simAlongRef = useRef(0);
  const [gpsWaited, setGpsWaited] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const announceIdRef = useRef(0);
  const announcedStepRef = useRef<number>(-1);
  const arrivedAnnouncedRef = useRef(false);

  const { enable, fix, geoError } = sensors;

  const emit = useCallback((kind: AnnouncementKind, step: RouteStep | null, distance: number) => {
    announceIdRef.current += 1;
    setAnnouncement({ id: announceIdRef.current, kind, step, distance });
  }, []);

  const start = useCallback(
    (route: RouteResult, mode: RouteMode, contribute: boolean) => {
      const line = toPolyline(route.geometry);
      const stepAlong = stepDistances(line, route.steps ?? []);
      setSession({ route, mode, line, stepAlong, startedAt: Date.now(), contribute });
      setSimulating(false);
      setSimPos(null);
      simAlongRef.current = 0;
      setGpsWaited(false);
      announcedStepRef.current = -1;
      arrivedAnnouncedRef.current = false;
      setLastConfidence({
        mode,
        score: route.confidence?.score ?? 0,
        label: route.confidence?.label ?? 'low',
        verified_pct: route.verified_pct,
        at: new Date().toISOString(),
      });
      void enable();
      const depart = route.steps?.[0] ?? null;
      emit('start', depart, 0);
    },
    [enable, emit],
  );

  const stop = useCallback(() => {
    setSession(null);
    setSimulating(false);
    setSimPos(null);
    setAnnouncement(null);
  }, []);

  // GPS wait timer: after GPS_WAIT_MS without a fix, offer the simulation.
  useEffect(() => {
    if (!session || fix) return;
    const id = window.setTimeout(() => setGpsWaited(true), GPS_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [session, fix]);

  // Position: the simulation while it runs, otherwise the GPS fix.
  const gpsPos: NavPosition | null = useMemo(
    () => (fix ? { lat: fix.lat, lon: fix.lon, heading: null, accuracy: fix.accuracy, simulated: false, ts: fix.ts } : null),
    [fix],
  );
  const position = simulating ? simPos : gpsPos;

  const projection = useMemo(() => (session && position ? project(session.line, position) : null), [session, position]);

  const derived = useMemo(() => {
    if (!session) {
      return { currentIndex: 0, distanceToStep: 0, remainingM: 0, progress: 0, offRoute: false, arrived: false };
    }
    const steps = session.route.steps ?? [];
    const length = session.line.length;
    const along = projection ? projection.along : 0;
    const offRoute = projection ? projection.offset > OFF_ROUTE_M : false;
    const destIndex = Math.max(0, steps.length - 1);
    let idx = steps.findIndex((_, i) => session.stepAlong[i] > along + STEP_AHEAD_M);
    if (idx === -1) idx = destIndex;
    const arrived = Boolean(projection) && along >= length - ARRIVE_M;
    if (arrived) idx = destIndex;
    const distanceToStep = Math.max(0, (session.stepAlong[idx] ?? length) - along);
    return {
      currentIndex: idx,
      distanceToStep,
      remainingM: Math.max(0, length - along),
      progress: length > 0 ? Math.min(1, along / length) : 0,
      offRoute,
      arrived,
    };
  }, [session, projection]);

  // Heading for the simulated walk comes from the line; the compass (when any) is read by the Explore screen itself.
  // Simulation timer.
  useEffect(() => {
    if (!session || !simulating) return;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      simAlongRef.current = Math.min(session.line.length, simAlongRef.current + simSpeed * dt);
      const p = pointAlong(session.line, simAlongRef.current);
      setSimPos({ ...p, heading: bearingAlong(session.line, simAlongRef.current), accuracy: null, simulated: true, ts: Date.now() });
    };
    tick();
    const id = window.setInterval(tick, SIM_TICK_MS);
    return () => window.clearInterval(id);
  }, [session, simulating, simSpeed]);

  const startSimulation = useCallback(() => {
    if (!session) return;
    // Start from where GPS put us when that is on the route; otherwise from the origin.
    const p = gpsPos ? project(session.line, gpsPos) : null;
    simAlongRef.current = p && p.offset <= OFF_ROUTE_M ? p.along : 0;
    setSimulating(true);
  }, [session, gpsPos]);

  const stopSimulation = useCallback(() => {
    setSimulating(false);
    setSimPos(null);
  }, []);

  const setSimSpeed = useCallback((s: SimSpeed) => setSimSpeedState(s), []);

  // Announce each new step once; the arrival once.
  const steps = session?.route.steps ?? [];
  const currentStep = session ? (steps[derived.currentIndex] ?? null) : null;
  useEffect(() => {
    if (!session || !projection) return;
    if (derived.arrived) {
      if (!arrivedAnnouncedRef.current) {
        arrivedAnnouncedRef.current = true;
        emit('arrive', steps[steps.length - 1] ?? null, 0);
      }
      return;
    }
    if (derived.currentIndex !== announcedStepRef.current) {
      announcedStepRef.current = derived.currentIndex;
      emit('step', currentStep, derived.distanceToStep);
    }
    // distanceToStep is read at the moment the step changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, projection !== null, derived.currentIndex, derived.arrived, emit]);

  const repeat = useCallback(() => {
    if (!session) return;
    if (derived.arrived) emit('arrive', steps[steps.length - 1] ?? null, 0);
    else emit('step', currentStep, derived.distanceToStep);
  }, [session, derived.arrived, derived.distanceToStep, currentStep, steps, emit]);

  const gps: GpsStatus = geoError === 'unsupported' ? 'unsupported' : geoError ? 'error' : fix ? 'ok' : 'waiting';
  const needsSimulation = Boolean(session) && !simulating && (gps === 'error' || gps === 'unsupported' || (gps === 'waiting' && gpsWaited) || (gps === 'ok' && derived.offRoute));

  const speed = session?.route.eta_s && session.route.length_m > 0 ? session.route.length_m / session.route.eta_s : 1;
  const etaMs = (derived.remainingM / Math.max(0.2, speed)) * 1000;

  const state: NavState = {
    session,
    position,
    projection,
    currentIndex: derived.currentIndex,
    currentStep,
    distanceToStep: derived.distanceToStep,
    remainingM: derived.remainingM,
    progress: derived.progress,
    etaMs,
    offRoute: derived.offRoute,
    arrived: derived.arrived,
    gps,
    simulating,
    simSpeed,
    needsSimulation,
    announcement,
  };

  return { state, start, stop, startSimulation, stopSimulation, setSimSpeed, repeat };
}
