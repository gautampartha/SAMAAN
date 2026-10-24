// State and actions for the Reach Gap page (P8): the anchor list, the target
// profile / cutoff / risk, the /reach result and the set of barriers whose fix
// is being simulated. Lives outside the components so the map (blobs) and the
// side panel share one source of truth, like the route planner.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  reachApi,
  REACH_CUTOFFS,
  REACH_PROFILES,
  RISKS,
  type ReachAnchor,
  type ReachCutoff,
  type ReachProfile,
  type ReachResponse,
  type Risk,
} from './api';
import { RISK_KEY } from './routePlanner';

export type ReachErrorKind = 'notFound' | 'badParams' | 'generic';

export interface ReachState {
  anchors: ReachAnchor[];
  anchorsLoading: boolean;
  anchorsError: boolean;
  anchorId: number | string | null;
  profile: ReachProfile;
  cutoff: ReachCutoff;
  risk: Risk;
  /** Barrier ids sent as `fixed=`; their fixes are simulated in the response. */
  fixed: number[];
  loading: boolean;
  error: ReachErrorKind | null;
  result: ReachResponse | null;
}

function readStoredRisk(): Risk {
  try {
    const v = localStorage.getItem(RISK_KEY);
    if (v && (RISKS as readonly string[]).includes(v)) return v as Risk;
  } catch {
    /* ignore */
  }
  return 'balanced';
}

function classifyError(err: unknown): ReachErrorKind {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'notFound';
    if (err.status === 422) return 'badParams';
  }
  return 'generic';
}

/** The first metro station, else the first anchor at all. */
export function defaultAnchor(anchors: ReachAnchor[]): ReachAnchor | null {
  return anchors.find((a) => a.kind === 'metro') ?? anchors[0] ?? null;
}

/**
 * `active` is true while the Reach Gap page is shown: anchors are fetched on the
 * first activation and `/reach` re-runs whenever a parameter changes. State is
 * kept while the user visits other pages so coming back shows the same result.
 */
export function useReachGap(active: boolean) {
  const [anchors, setAnchors] = useState<ReachAnchor[]>([]);
  const [anchorsLoading, setAnchorsLoading] = useState(false);
  const [anchorsError, setAnchorsError] = useState(false);
  const [anchorId, setAnchorIdState] = useState<number | string | null>(null);
  const [profile, setProfileState] = useState<ReachProfile>(REACH_PROFILES[0]);
  const [cutoff, setCutoffState] = useState<ReachCutoff>(REACH_CUTOFFS[1]);
  const [risk, setRiskState] = useState<Risk>(readStoredRisk);
  const [fixed, setFixed] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ReachErrorKind | null>(null);
  const [result, setResult] = useState<ReachResponse | null>(null);
  const [anchorsNonce, setAnchorsNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Anchors: on every activation and per "Check again". No "already sent" guard: React
  // StrictMode (dev) runs effects twice and aborts the first request on the simulated unmount,
  // which left the page on "Loading places…" forever when a guard was in place. The call is cheap.
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    setAnchorsLoading(true);
    setAnchorsError(false);
    reachApi
      .anchors(ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        setAnchors(res.anchors);
        setAnchorIdState((cur) => (cur !== null && res.anchors.some((a) => a.id === cur) ? cur : (defaultAnchor(res.anchors)?.id ?? null)));
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('[reach]', err);
        setAnchorsError(true);
      })
      .finally(() => {
        if (!ac.signal.aborted) setAnchorsLoading(false);
      });
    return () => ac.abort();
  }, [active, anchorsNonce]);

  // Reach: whenever the parameters change while the page is shown.
  useEffect(() => {
    if (!active || anchorId === null) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const simulation = fixed.length > 0;
    setLoading(true);
    setError(null);
    reachApi
      .reach({ anchor: anchorId, profile, cutoff_min: cutoff, risk, fixed }, ac.signal)
      .then((res) => {
        if (ac.signal.aborted) return;
        setResult(res);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('[reach]', err);
        setError(classifyError(err));
        // A failed simulation keeps the base result on screen; a failed base request must not show stale numbers.
        if (!simulation) setResult(null);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [active, anchorId, profile, cutoff, risk, fixed]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Changing a base parameter invalidates the ranked fixes, so the simulation is cleared.
  const setAnchor = useCallback((id: number | string) => {
    setAnchorIdState(id);
    setFixed([]);
  }, []);
  const setProfile = useCallback((p: ReachProfile) => {
    setProfileState(p);
    setFixed([]);
  }, []);
  const setCutoff = useCallback((c: ReachCutoff) => {
    setCutoffState(c);
    setFixed([]);
  }, []);
  const setRisk = useCallback((r: Risk) => {
    setRiskState(r);
    setFixed([]);
  }, []);

  const toggleFix = useCallback((id: number) => {
    setFixed((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);
  const simulateAll = useCallback(() => {
    setFixed(result ? result.fixes.map((f) => f.barrier.id) : []);
  }, [result]);
  const clearFixes = useCallback(() => setFixed([]), []);

  const retryAnchors = useCallback(() => setAnchorsNonce((n) => n + 1), []);
  /** Repeat the last `/reach` request (after an error). */
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  useEffect(() => {
    if (retryNonce === 0) return;
    // Re-create the `fixed` array so the reach effect runs again with the same parameters.
    setFixed((cur) => [...cur]);
  }, [retryNonce]);

  const state: ReachState = {
    anchors,
    anchorsLoading,
    anchorsError,
    anchorId,
    profile,
    cutoff,
    risk,
    fixed,
    loading,
    error,
    result,
  };

  return { state, setAnchor, setProfile, setCutoff, setRisk, toggleFix, simulateAll, clearFixes, retry, retryAnchors };
}

export type ReachGapApi = ReturnType<typeof useReachGap>;
