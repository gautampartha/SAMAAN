// GPS + compass + pitch for the capture page. Visual state updates freely
// (throttled to ~10 Hz); the latest raw values are also exposed through refs so
// capture and the 2 s screen-reader summary can read them without re-rendering.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { HeadingSource } from './api';

export interface GeoFix {
  lat: number;
  lon: number;
  /** Horizontal accuracy in metres. */
  accuracy: number;
  /** Ground speed in m/s, when the device reports it. */
  speed: number | null;
  /** Epoch ms of the fix. */
  ts: number;
}

export interface Orientation {
  /** Compass heading 0-360, clockwise from north; null when no compass data. */
  heading: number | null;
  /** Degrees above (+) or below (-) the horizon for a phone held upright; null if unknown. */
  pitch: number | null;
  source: HeadingSource;
  ts: number;
}

export type GeoQuality = 'good' | 'ok' | 'poor';
export type GeoErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported';
export type SensorPermission = 'idle' | 'requesting' | 'granted' | 'denied';

export function geoQuality(accuracy: number): GeoQuality {
  if (accuracy <= 8) return 'good';
  if (accuracy <= 20) return 'ok';
  return 'poor';
}

/** Great-circle distance in metres. */
export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Eight-point compass label key for a heading in degrees. */
export function cardinal(heading: number): 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' {
  const keys = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
  return keys[Math.round((((heading % 360) + 360) % 360) / 45) % 8];
}

type OrientationEventWithWebkit = DeviceOrientationEvent & { webkitCompassHeading?: number };

function readOrientation(e: DeviceOrientationEvent): Orientation {
  const webkit = (e as OrientationEventWithWebkit).webkitCompassHeading;
  let heading: number | null = null;
  let source: HeadingSource = 'none';
  if (typeof webkit === 'number' && Number.isFinite(webkit)) {
    // iOS: already a true compass heading, clockwise from north.
    heading = webkit;
    source = 'absolute';
  } else if (typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    heading = (360 - e.alpha) % 360;
    source = e.absolute ? 'absolute' : 'relative';
  }
  const pitch = typeof e.beta === 'number' && Number.isFinite(e.beta) ? e.beta - 90 : null;
  return { heading, pitch, source, ts: Date.now() };
}

type RequestPermissionFn = () => Promise<'granted' | 'denied' | 'prompt' | string>;

function orientationPermissionFn(): RequestPermissionFn | null {
  if (typeof DeviceOrientationEvent === 'undefined') return null;
  const fn = (DeviceOrientationEvent as unknown as { requestPermission?: RequestPermissionFn }).requestPermission;
  return typeof fn === 'function' ? fn : null;
}

const VISUAL_THROTTLE_MS = 100;

export interface Sensors {
  fix: GeoFix | null;
  orientation: Orientation | null;
  geoError: GeoErrorKind | null;
  permission: SensorPermission;
  /** True once the user tapped "Enable sensors" and watchers are running. */
  enabled: boolean;
  /** True when this browser needs an explicit tap to grant motion sensors (iOS). */
  needsTap: boolean;
  enable: () => Promise<void>;
  fixRef: MutableRefObject<GeoFix | null>;
  orientationRef: MutableRefObject<Orientation | null>;
}

export function useSensors(): Sensors {
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [orientation, setOrientation] = useState<Orientation | null>(null);
  const [geoError, setGeoError] = useState<GeoErrorKind | null>(null);
  const [permission, setPermission] = useState<SensorPermission>('idle');
  const [enabled, setEnabled] = useState(false);

  const fixRef = useRef<GeoFix | null>(null);
  const orientationRef = useRef<Orientation | null>(null);
  const lastPaintRef = useRef(0);
  const watchIdRef = useRef<number | null>(null);
  const cleanupOrientationRef = useRef<(() => void) | null>(null);

  const startOrientation = useCallback(() => {
    cleanupOrientationRef.current?.();
    const handler = (e: Event) => {
      const o = readOrientation(e as DeviceOrientationEvent);
      orientationRef.current = o;
      const now = Date.now();
      if (now - lastPaintRef.current >= VISUAL_THROTTLE_MS) {
        lastPaintRef.current = now;
        setOrientation(o);
      }
    };
    // Prefer the absolute event (Chrome/Android); fall back to the plain one.
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(type, handler, { passive: true });
    cleanupOrientationRef.current = () => window.removeEventListener(type, handler);
  }, []);

  const startGeolocation = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setGeoError('unsupported');
      return;
    }
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const f: GeoFix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: typeof pos.coords.speed === 'number' && Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
          ts: pos.timestamp,
        };
        fixRef.current = f;
        setFix(f);
        setGeoError(null);
      },
      (err) => {
        setGeoError(err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }, []);

  const enable = useCallback(async () => {
    setPermission('requesting');
    const req = orientationPermissionFn();
    let granted = true;
    if (req) {
      try {
        granted = (await req.call(DeviceOrientationEvent)) === 'granted';
      } catch {
        granted = false;
      }
    }
    setPermission(granted ? 'granted' : 'denied');
    if (granted) startOrientation();
    startGeolocation();
    setEnabled(true);
  }, [startGeolocation, startOrientation]);

  useEffect(() => {
    return () => {
      cleanupOrientationRef.current?.();
      cleanupOrientationRef.current = null;
      if (watchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, []);

  return {
    fix,
    orientation,
    geoError,
    permission,
    enabled,
    needsTap: orientationPermissionFn() !== null,
    enable,
    fixRef,
    orientationRef,
  };
}
