// App-wide small settings shared by Home, Navigate, Explore, Listen, Contribute and
// Statistics: the chosen mode (move / explore / listen), the "contribute photos
// while I navigate" consent and the confidence of the last route. Each is a tiny
// external store backed by localStorage so every page reads the same value.
import { useSyncExternalStore } from 'react';
import type { AppMode, ConfidenceLabel, RouteMode } from './api';

export const MODE_KEY = 'samaan.mode';
export const CONTRIBUTE_KEY = 'samaan.contribute';
export const LAST_CONFIDENCE_KEY = 'samaan.lastConfidence';

export const APP_MODES: readonly AppMode[] = ['move', 'explore', 'listen'] as const;

function makeStore<T>(key: string, parse: (raw: string | null) => T, serialise: (v: T) => string | null) {
  let current: T = parse(readRaw(key));
  const listeners = new Set<() => void>();
  function readRaw(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  return {
    get: () => current,
    set: (v: T) => {
      current = v;
      try {
        const s = serialise(v);
        if (s === null) localStorage.removeItem(key);
        else localStorage.setItem(key, s);
      } catch {
        /* ignore */
      }
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

const modeStore = makeStore<AppMode>(
  MODE_KEY,
  (raw) => (raw === 'explore' || raw === 'listen' ? raw : 'move'),
  (v) => v,
);
export const getMode = modeStore.get;
export const setMode = modeStore.set;
export function useMode(): AppMode {
  return useSyncExternalStore(modeStore.subscribe, modeStore.get, modeStore.get);
}

const contributeStore = makeStore<boolean>(
  CONTRIBUTE_KEY,
  (raw) => raw === '1',
  (v) => (v ? '1' : '0'),
);
export const getContribute = contributeStore.get;
export const setContribute = contributeStore.set;
export function useContribute(): boolean {
  return useSyncExternalStore(contributeStore.subscribe, contributeStore.get, contributeStore.get);
}

export interface LastConfidence {
  mode: RouteMode;
  score: number;
  label: ConfidenceLabel;
  verified_pct: number;
  /** ISO timestamp of the trip start. */
  at: string;
}

const lastConfidenceStore = makeStore<LastConfidence | null>(
  LAST_CONFIDENCE_KEY,
  (raw) => {
    if (!raw) return null;
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === 'object' && typeof (v as LastConfidence).score === 'number' && typeof (v as LastConfidence).label === 'string') {
        return v as LastConfidence;
      }
    } catch {
      /* ignore */
    }
    return null;
  },
  (v) => (v ? JSON.stringify(v) : null),
);
export const setLastConfidence = lastConfidenceStore.set;
export function useLastConfidence(): LastConfidence | null {
  return useSyncExternalStore(lastConfidenceStore.subscribe, lastConfidenceStore.get, lastConfidenceStore.get);
}
