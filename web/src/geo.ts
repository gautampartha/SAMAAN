// Small geometry helpers for turn-by-turn navigation: distances along a route,
// projecting a GPS fix onto the line, bearings, and moving a point along the
// line (used by the simulated walk). Everything works in metres with a local
// equirectangular approximation, which is accurate well below 1 m over a campus.
import type { LineString } from 'geojson';
import { haversineM } from './sensors';

export interface LatLon {
  lat: number;
  lon: number;
}

/** A route prepared for fast projection: vertices plus cumulative distance to each. */
export interface Polyline {
  coords: LatLon[];
  /** Metres from the start to vertex i. */
  cum: number[];
  length: number;
}

export function toPolyline(geometry: LineString): Polyline {
  const coords = geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineM(coords[i - 1], coords[i]));
  return { coords, cum, length: cum[cum.length - 1] ?? 0 };
}

/** Metres per degree at this latitude (x = longitude, y = latitude). */
function metresPerDegree(lat: number): { x: number; y: number } {
  return { x: 111320 * Math.cos((lat * Math.PI) / 180), y: 110540 };
}

export interface Projection {
  /** Nearest point on the line. */
  point: LatLon;
  /** Metres from the start of the line to that point. */
  along: number;
  /** Metres from the query point to the line. */
  offset: number;
  /** Index of the segment [i, i+1] that was nearest. */
  segment: number;
}

/** Nearest point on the polyline to `p`. */
export function project(line: Polyline, p: LatLon): Projection {
  const { coords, cum } = line;
  if (coords.length === 0) return { point: p, along: 0, offset: 0, segment: 0 };
  if (coords.length === 1) return { point: coords[0], along: 0, offset: haversineM(p, coords[0]), segment: 0 };
  const mpd = metresPerDegree(p.lat);
  let best: Projection | null = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const ax = (a.lon - p.lon) * mpd.x;
    const ay = (a.lat - p.lat) * mpd.y;
    const bx = (b.lon - p.lon) * mpd.x;
    const by = (b.lat - p.lat) * mpd.y;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const offset = Math.hypot(qx, qy);
    if (!best || offset < best.offset) {
      const segLen = cum[i + 1] - cum[i];
      best = {
        point: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t },
        along: cum[i] + segLen * t,
        offset,
        segment: i,
      };
    }
  }
  return best as Projection;
}

/** The point `along` metres from the start of the line (clamped to both ends). */
export function pointAlong(line: Polyline, along: number): LatLon {
  const { coords, cum } = line;
  if (coords.length === 0) return { lat: 0, lon: 0 };
  if (along <= 0) return coords[0];
  if (along >= line.length) return coords[coords.length - 1];
  let i = 1;
  while (i < cum.length && cum[i] < along) i++;
  const a = coords[i - 1];
  const b = coords[i];
  const segLen = cum[i] - cum[i - 1];
  const t = segLen === 0 ? 0 : (along - cum[i - 1]) / segLen;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** Initial bearing from a to b, degrees clockwise from north, 0-360. */
export function bearing(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Direction of travel of the line at `along` metres (bearing of the segment there). */
export function bearingAlong(line: Polyline, along: number): number {
  const { coords, cum } = line;
  if (coords.length < 2) return 0;
  let i = 1;
  while (i < cum.length - 1 && cum[i] <= along) i++;
  return bearing(coords[i - 1], coords[i]);
}

/** Signed smallest difference a - b in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Snap to the nearest multiple of 45° when within `tolerance`; otherwise return the angle unchanged. */
export function snapToEight(deg: number, tolerance = 15): number {
  const norm = ((deg % 360) + 360) % 360;
  const nearest = Math.round(norm / 45) * 45;
  return Math.abs(angleDiff(norm, nearest)) <= tolerance ? nearest % 360 : norm;
}

export function formatDistance(m: number): { value: string; unit: 'm' | 'km' } {
  if (m >= 1000) return { value: (m / 1000).toFixed(m >= 10000 ? 0 : 1), unit: 'km' };
  if (m >= 100) return { value: String(Math.round(m / 10) * 10), unit: 'm' };
  return { value: String(Math.max(0, Math.round(m / 5) * 5)), unit: 'm' };
}
