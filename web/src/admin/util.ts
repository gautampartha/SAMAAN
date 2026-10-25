import { useCallback, useEffect, useRef, useState } from 'react';

export type Lang = 'en' | 'hi';
export const toLang = (l: string | undefined): Lang => (l && l.startsWith('hi') ? 'hi' : 'en');

/** "3 h ago" / "in 2 days" in the UI language. */
export function relTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '–';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '–';
  const diff = (then - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-IN', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function fmtDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short' }) : iso;
}

/** First-seen age: "5 h", "12 d", or "Aug 2017" for anything older than 60 days. */
export function ageLabel(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '–';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '–';
  const days = (Date.now() - t) / 86400000;
  const loc = lang === 'hi' ? 'hi-IN' : 'en-IN';
  if (days < 1) return relTime(iso, lang);
  if (days < 60) return new Intl.RelativeTimeFormat(loc, { numeric: 'auto' }).format(-Math.round(days), 'day');
  return new Date(iso).toLocaleDateString(loc, { month: 'short', year: 'numeric' });
}

export function mapsLink(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=19/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch on mount, on `deps` change, on `reload()`, and every `pollMs` (0 = never). Keeps old data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs = 0): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    if (!pollMs) return;
    const id = window.setInterval(() => setTick((t) => t + 1), pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
