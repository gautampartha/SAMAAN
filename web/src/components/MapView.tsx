import { useEffect, useRef, useState } from 'react';
import maplibregl, {
  Map as MapLibreMap,
  Popup,
  type AddLayerObject,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { Feature, FeatureCollection, Geometry, LineString, MultiPolygon, Point, Polygon, Position } from 'geojson';
import {
  imagePhotoUrl,
  localizedName,
  photoUrl,
  LAYER_KEYS,
  ROUTE_MODES,
  type AnchorProps,
  type BarrierFeature,
  type BarrierProps,
  type CoverageProps,
  type DemoProps,
  type FootpathFC,
  type ImageProps,
  type LayerData,
  type LayerKey,
  type MissionFeature,
  type ReachResponse,
  type ReportItem,
  type ReportTarget,
  type RouteMode,
  type RouteResponse,
  type Zone,
} from '../api';
import type { Lang } from '../i18n';
import type { PlannerPoint, PointRole } from '../routePlanner';
import { ROUTE_ENDPOINT_COLOURS, ROUTE_STYLES, UNKNOWN_OVERLAY_COLOUR } from './routeStyles';
import { REACH_ANCHOR_COLOUR, REACH_FIX_COLOUR, REACH_FIX_DONE_COLOUR, REACH_STYLES } from './reachStyles';

export interface BarrierSelection {
  feature: BarrierFeature;
  /** Changes on every selection so re-selecting the same barrier re-flies. */
  nonce: number;
}

/** "Show" pressed on a Reach Gap fix row: fly to this barrier (and open its popup when it is on the map). */
export interface ReachFocus {
  barrierId: number;
  lat: number;
  lon: number;
  /** Changes on every press so re-showing the same barrier re-flies. */
  nonce: number;
}

interface MapViewProps {
  zone: Zone | null;
  /** True once the /zone request has either succeeded or failed. */
  zoneSettled: boolean;
  data: LayerData;
  visible: Record<LayerKey, boolean>;
  lang: Lang;
  selection: BarrierSelection | null;
  onBasemapError: () => void;
  /** Route planner: compared routes, the highlighted one, and map-pick mode. */
  routes: RouteResponse | null;
  selectedRoute: RouteMode | null;
  onSelectRoute: (mode: RouteMode) => void;
  origin: PlannerPoint | null;
  destination: PlannerPoint | null;
  pickMode: PointRole | null;
  onPick: (role: PointRole, lat: number, lon: number) => void;
  /** Reports sent this session that are still pending: hollow markers until validated. */
  pendingReports: ReportItem[];
  /** Mission highlighted from the Missions page (thick dashed grey line + label). */
  mission: MissionFeature | null;
  /** "Report as fixed" pressed in a barrier popup. */
  onReportFixed: (target: ReportTarget) => void;
  /** Reach Gap page: walker / target / simulated hulls, the anchor and the ranked fixes. null = page not shown. */
  reach: ReachResponse | null;
  /** Barrier ids currently simulated as fixed (their pins turn green). */
  reachFixed: number[];
  reachFocus: ReachFocus | null;
}

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };
// Used only when /zone is unreachable: an empty map, no invented features.
const EMPTY_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

// Fonts come from the basemap's glyph server. Single font name to stay compatible
// with static glyph hosting (comma-separated fontstacks are not always supported).
const TEXT_FONT = ['Noto Sans Regular'];

const LAYER_IDS: Record<LayerKey, string[]> = {
  coverage: ['coverage-unobserved', 'coverage-observed'],
  footpaths: ['footpaths-unknown', 'footpaths-clear', 'footpaths-blocked'],
  demo: ['demo-path-casing', 'demo-path', 'demo-endpoints', 'demo-endpoints-label'],
  anchors: ['anchors', 'anchors-label'],
  barriers: ['barriers', 'barriers-label'],
  images: ['images', 'images-heading'],
};

/** Point layers that open popups; a coverage click is ignored when one of these is hit too. */
const POINT_CLICK_LAYERS = ['barriers', 'anchors', 'demo-endpoints', 'images', 'pending-reports'];

// Route planner / citizen-loop / reach-gap sources (not user-toggleable; driven by app state).
const ROUTE_SOURCES = [
  'routes',
  'route-endpoints',
  'route-unknown',
  'route-barriers',
  'pending-reports',
  'missions',
  'reach-walker',
  'reach-target',
  'reach-simulated',
  'reach-anchor',
  'reach-fixes',
] as const;
const STAR_IMAGE = 'samaan-anchor-star';
const SIM_GROW_MS = 600;
export const PENDING_REPORT_COLOUR = '#0b5fa5';
export const MISSION_COLOUR = '#424242';
const ROUTE_LINE_LAYERS: Record<RouteMode, string[]> = {
  shortest: ['route-shortest'],
  naive_accessible: ['route-naive'],
  samaan: ['route-samaan-casing', 'route-samaan'],
};
const ROUTE_CLICK_LAYERS = ['route-shortest', 'route-naive', 'route-samaan'];
const RING_RADIUS = 18;

// Image colours per source (also named in words in the legend).
export const IMAGE_COLOURS = { mapillary: '#00838f', own: '#ad1457', report: '#5d4037', other: '#616161' } as const;
const ARROW_IMAGE = 'samaan-heading-arrow';

/** Up-pointing triangle, drawn on a canvas so no external asset or data URL is needed. */
function headingArrowImage(): ImageData | null {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size * 2;
  canvas.height = size * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(2, 2);
  ctx.beginPath();
  ctx.moveTo(size / 2, 1);
  ctx.lineTo(size - 4, size - 3);
  ctx.lineTo(size / 2, size - 7);
  ctx.lineTo(4, size - 3);
  ctx.closePath();
  ctx.fillStyle = '#111111';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  return ctx.getImageData(0, 0, size * 2, size * 2);
}

/** Five-point star with a white edge for the reach anchor, drawn on a canvas (no glyph dependency). */
function starImage(): ImageData | null {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size * 2;
  canvas.height = size * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(2, 2);
  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - 2;
  const inner = outer * 0.45;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = REACH_ANCHOR_COLOUR;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  return ctx.getImageData(0, 0, size * 2, size * 2);
}

function nameProp(lang: Lang): 'name_hi' | 'name_en' {
  return lang === 'hi' ? 'name_hi' : 'name_en';
}

function addSourcesAndLayers(map: MapLibreMap, lang: Lang): void {
  for (const key of LAYER_KEYS) {
    if (!map.getSource(key)) map.addSource(key, { type: 'geojson', data: EMPTY_FC });
  }
  const hasGlyphs = Boolean(map.getStyle()?.glyphs);
  const add = (layer: AddLayerObject) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  };

  // --- Image coverage (below everything else) ---
  add({
    id: 'coverage-unobserved',
    type: 'line',
    source: 'coverage',
    filter: ['!=', ['get', 'observed'], true],
    paint: { 'line-color': '#757575', 'line-width': 10, 'line-opacity': 0.18 },
  });
  add({
    id: 'coverage-observed',
    type: 'line',
    source: 'coverage',
    filter: ['==', ['get', 'observed'], true],
    paint: { 'line-color': '#1565c0', 'line-width': 10, 'line-opacity': 0.35 },
  });

  // --- Reach Gap blobs (fills below the footpaths so the network stays readable) ---
  const rw = REACH_STYLES.walker;
  const rt = REACH_STYLES.target;
  const rs = REACH_STYLES.simulated;
  add({ id: 'reach-walker-fill', type: 'fill', source: 'reach-walker', paint: { 'fill-color': rw.fill, 'fill-opacity': rw.fillOpacity } });
  add({ id: 'reach-target-fill', type: 'fill', source: 'reach-target', paint: { 'fill-color': rt.fill, 'fill-opacity': rt.fillOpacity } });
  // Simulated blob above the target blob; its opacity grows from 0 when a simulation arrives.
  add({ id: 'reach-simulated-fill', type: 'fill', source: 'reach-simulated', paint: { 'fill-color': rs.fill, 'fill-opacity': rs.fillOpacity } });

  // --- Footpaths: colour AND pattern/width differ per state ---
  add({
    id: 'footpaths-unknown',
    type: 'line',
    source: 'footpaths',
    filter: ['==', ['get', 'state'], 'unknown'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '#6d6d6d', 'line-width': 3, 'line-dasharray': [3, 2] },
  });
  add({
    id: 'footpaths-clear',
    type: 'line',
    source: 'footpaths',
    filter: ['==', ['get', 'state'], 'clear'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#1b7f3b', 'line-width': 4 },
  });
  add({
    id: 'footpaths-blocked',
    type: 'line',
    source: 'footpaths',
    filter: ['==', ['get', 'state'], 'blocked'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#c62828', 'line-width': 6, 'line-dasharray': [0.1, 1.8] },
  });

  // --- Reach Gap outlines: solid (walker) / dashed (target) / dotted (simulated), above the footpaths ---
  add({
    id: 'reach-walker-line',
    type: 'line',
    source: 'reach-walker',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': rw.line, 'line-width': rw.lineWidth },
  });
  add({
    id: 'reach-target-line',
    type: 'line',
    source: 'reach-target',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': rt.line, 'line-width': rt.lineWidth, 'line-dasharray': rt.dash },
  });
  add({
    id: 'reach-simulated-line',
    type: 'line',
    source: 'reach-simulated',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': rs.line, 'line-width': rs.lineWidth, 'line-dasharray': rs.dash },
  });

  // --- Highlighted mission: thick dashed grey line with a white casing and the street name along it ---
  add({
    id: 'missions-casing',
    type: 'line',
    source: 'missions',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 13 },
  });
  add({
    id: 'missions',
    type: 'line',
    source: 'missions',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': MISSION_COLOUR, 'line-width': 8, 'line-dasharray': [1.5, 1] },
  });
  if (hasGlyphs) {
    add({
      id: 'missions-label',
      type: 'symbol',
      source: 'missions',
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', nameProp(lang)],
        'text-font': TEXT_FONT,
        'text-size': 13,
        'text-offset': [0, -1.4],
        'text-optional': true,
      },
      paint: { 'text-color': '#111111', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
  }

  // --- Compared routes: three styles that differ in width AND dash, not only colour ---
  const sh = ROUTE_STYLES.shortest;
  const na = ROUTE_STYLES.naive_accessible;
  const sa = ROUTE_STYLES.samaan;
  add({
    id: 'route-samaan-casing',
    type: 'line',
    source: 'routes',
    filter: ['==', ['get', 'mode'], 'samaan'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': sa.width + 4 },
  });
  add({
    id: 'route-samaan',
    type: 'line',
    source: 'routes',
    filter: ['==', ['get', 'mode'], 'samaan'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': sa.colour, 'line-width': sa.width },
  });
  add({
    id: 'route-naive',
    type: 'line',
    source: 'routes',
    filter: ['==', ['get', 'mode'], 'naive_accessible'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': na.colour, 'line-width': na.width, 'line-dasharray': na.dash },
  });
  add({
    id: 'route-shortest',
    type: 'line',
    source: 'routes',
    filter: ['==', ['get', 'mode'], 'shortest'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': sh.colour, 'line-width': sh.width, 'line-dasharray': sh.dash },
  });
  // Unknown (never checked) stretches of the highlighted route: grey stripes on top of it.
  add({
    id: 'route-unknown',
    type: 'line',
    source: 'route-unknown',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': UNKNOWN_OVERLAY_COLOUR, 'line-width': sa.width + 2, 'line-dasharray': [1, 1], 'line-opacity': 0.85 },
  });

  // --- Demo route: wide dashed purple line with white casing + A/B endpoints ---
  add({
    id: 'demo-path-casing',
    type: 'line',
    source: 'demo',
    filter: ['==', ['get', 'role'], 'path'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 11 },
  });
  add({
    id: 'demo-path',
    type: 'line',
    source: 'demo',
    filter: ['==', ['get', 'role'], 'path'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#5e35b1', 'line-width': 6, 'line-dasharray': [2, 1] },
  });

  // --- Anchors: white circle with dark ring + name label ---
  add({
    id: 'anchors',
    type: 'circle',
    source: 'anchors',
    paint: {
      'circle-radius': 8,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#263238',
      'circle-stroke-width': 3,
    },
  });
  if (hasGlyphs) {
    add({
      id: 'anchors-label',
      type: 'symbol',
      source: 'anchors',
      layout: {
        'text-field': ['get', nameProp(lang)],
        'text-font': TEXT_FONT,
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: { 'text-color': '#263238', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    });
  }

  // --- Barriers: size (and colour) by severity, number label as a non-colour cue ---
  add({
    id: 'barriers',
    type: 'circle',
    source: 'barriers',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'severity'], 1, 6, 5, 14],
      'circle-color': ['step', ['get', 'severity'], '#f9a825', 3, '#ef6c00', 4, '#b71c1c'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
      'circle-opacity': ['match', ['get', 'status'], 'active', 0.95, 0.45],
      'circle-stroke-opacity': ['match', ['get', 'status'], 'active', 1, 0.5],
    },
  });
  if (hasGlyphs) {
    add({
      id: 'barriers-label',
      type: 'symbol',
      source: 'barriers',
      layout: {
        'text-field': ['to-string', ['get', 'severity']],
        'text-font': TEXT_FONT,
        'text-size': ['interpolate', ['linear'], ['get', 'severity'], 1, 9, 5, 13],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff' },
    });
  }

  // --- Images: small circle coloured by source; arrow rotated by compass heading ---
  add({
    id: 'images',
    type: 'circle',
    source: 'images',
    paint: {
      'circle-radius': ['match', ['get', 'source'], 'own', 6, 5],
      'circle-color': [
        'match',
        ['get', 'source'],
        'mapillary',
        IMAGE_COLOURS.mapillary,
        'own',
        IMAGE_COLOURS.own,
        'report',
        IMAGE_COLOURS.report,
        IMAGE_COLOURS.other,
      ],
      // Own photos get a dark ring, others a white one, so source is not colour-only.
      'circle-stroke-color': ['match', ['get', 'source'], 'own', '#111111', '#ffffff'],
      'circle-stroke-width': ['match', ['get', 'source'], 'own', 2, 1.5],
    },
  });
  if (!map.hasImage(ARROW_IMAGE)) {
    const img = headingArrowImage();
    if (img) map.addImage(ARROW_IMAGE, img, { pixelRatio: 2 });
  }
  if (map.hasImage(ARROW_IMAGE)) {
    add({
      id: 'images-heading',
      type: 'symbol',
      source: 'images',
      filter: ['==', ['typeof', ['get', 'heading_deg']], 'number'],
      layout: {
        'icon-image': ARROW_IMAGE,
        'icon-size': 0.6,
        'icon-rotate': ['get', 'heading_deg'],
        'icon-rotation-alignment': 'map',
        // Offset is applied in the rotated frame: the arrow sits just ahead of the circle.
        'icon-offset': [0, -16],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  }

  // --- Demo endpoints on top ---
  add({
    id: 'demo-endpoints',
    type: 'circle',
    source: 'demo',
    filter: ['in', ['get', 'role'], ['literal', ['origin', 'destination']]],
    paint: {
      'circle-radius': 12,
      'circle-color': ['match', ['get', 'role'], 'origin', '#1b5e20', '#5e35b1'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
    },
  });
  if (hasGlyphs) {
    add({
      id: 'demo-endpoints-label',
      type: 'symbol',
      source: 'demo',
      filter: ['in', ['get', 'role'], ['literal', ['origin', 'destination']]],
      layout: {
        'text-field': ['match', ['get', 'role'], 'origin', 'A', 'B'],
        'text-font': TEXT_FONT,
        'text-size': 13,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff' },
    });
  }
}

function addRouteSources(map: MapLibreMap): void {
  for (const key of ROUTE_SOURCES) {
    if (!map.getSource(key)) map.addSource(key, { type: 'geojson', data: EMPTY_FC });
  }
}

/** Layers that sit above every data layer: barrier rings on the highlighted route and the A/B pins. */
function addRouteTopLayers(map: MapLibreMap): void {
  const hasGlyphs = Boolean(map.getStyle()?.glyphs);
  const add = (layer: AddLayerObject) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  };
  add({
    id: 'route-barriers-ring',
    type: 'circle',
    source: 'route-barriers',
    paint: {
      'circle-radius': RING_RADIUS,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': ['case', ['get', 'impassable_for_profile'], '#b71c1c', '#ef6c00'],
      'circle-stroke-width': 4,
      'circle-stroke-opacity': 0.9,
    },
  });
  add({
    id: 'route-barriers-dot',
    type: 'circle',
    source: 'route-barriers',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'severity'], 1, 6, 5, 11],
      'circle-color': ['step', ['get', 'severity'], '#f9a825', 3, '#ef6c00', 4, '#b71c1c'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
  add({
    id: 'route-endpoints',
    type: 'circle',
    source: 'route-endpoints',
    paint: {
      'circle-radius': 13,
      'circle-color': ['match', ['get', 'role'], 'origin', ROUTE_ENDPOINT_COLOURS.origin, ROUTE_ENDPOINT_COLOURS.destination],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
    },
  });
  // Pending reports (this session, not yet validated): hollow ring with a "?" so they are not mistaken for barriers.
  add({
    id: 'pending-reports',
    type: 'circle',
    source: 'pending-reports',
    paint: {
      'circle-radius': 10,
      'circle-color': 'rgba(255,255,255,0.85)',
      'circle-stroke-color': PENDING_REPORT_COLOUR,
      'circle-stroke-width': 3,
    },
  });
  if (hasGlyphs) {
    add({
      id: 'pending-reports-label',
      type: 'symbol',
      source: 'pending-reports',
      layout: { 'text-field': '?', 'text-font': TEXT_FONT, 'text-size': 13, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': PENDING_REPORT_COLOUR },
    });
  }
  if (hasGlyphs) {
    add({
      id: 'route-endpoints-label',
      type: 'symbol',
      source: 'route-endpoints',
      layout: {
        'text-field': ['match', ['get', 'role'], 'origin', 'A', 'B'],
        'text-font': TEXT_FONT,
        'text-size': 14,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff' },
    });
  }

  // --- Reach Gap: numbered pins for the ranked fixes (green once simulated) and the anchor star ---
  add({
    id: 'reach-fixes',
    type: 'circle',
    source: 'reach-fixes',
    paint: {
      'circle-radius': 12,
      'circle-color': ['case', ['get', 'fixed'], REACH_FIX_DONE_COLOUR, REACH_FIX_COLOUR],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
    },
  });
  if (hasGlyphs) {
    add({
      id: 'reach-fixes-label',
      type: 'symbol',
      source: 'reach-fixes',
      layout: {
        'text-field': ['to-string', ['get', 'rank']],
        'text-font': TEXT_FONT,
        'text-size': 13,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff' },
    });
  }
  if (!map.hasImage(STAR_IMAGE)) {
    const img = starImage();
    if (img) map.addImage(STAR_IMAGE, img, { pixelRatio: 2 });
  }
  if (map.hasImage(STAR_IMAGE)) {
    add({
      id: 'reach-anchor',
      type: 'symbol',
      source: 'reach-anchor',
      layout: { 'icon-image': STAR_IMAGE, 'icon-size': 1, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    });
  } else {
    add({
      id: 'reach-anchor',
      type: 'circle',
      source: 'reach-anchor',
      paint: { 'circle-radius': 12, 'circle-color': REACH_ANCHOR_COLOUR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 },
    });
  }
  if (hasGlyphs) {
    add({
      id: 'reach-anchor-label',
      type: 'symbol',
      source: 'reach-anchor',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': TEXT_FONT,
        'text-size': 13,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-allow-overlap': true,
      },
      paint: { 'text-color': REACH_ANCHOR_COLOUR, 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
  }
}

// ---------- Reach Gap helpers ----------

function hullToFC(hull: Polygon | MultiPolygon | null | undefined): FeatureCollection {
  return { type: 'FeatureCollection', features: hull ? [{ type: 'Feature', geometry: hull, properties: {} }] : [] };
}

function reachAnchorToFC(reach: ReachResponse | null, lang: Lang, anchorWord: string): FeatureCollection<Point> {
  if (!reach) return { type: 'FeatureCollection', features: [] };
  const a = reach.anchor;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: { label: `${anchorWord}: ${localizedName(a, lang)}` },
      },
    ],
  };
}

function reachFixesToFC(reach: ReachResponse | null, fixed: number[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: (reach?.fixes ?? []).map((f) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.barrier.lon, f.barrier.lat] },
      properties: { id: f.barrier.id, rank: f.rank, fixed: fixed.includes(f.barrier.id) },
    })),
  };
}

/** Bounding box of any GeoJSON geometry (walks nested coordinate arrays). */
function boundsOfGeometry(geom: Geometry | null | undefined): [[number, number], [number, number]] | null {
  if (!geom) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const visit = (c: unknown) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      const [x, y] = c as Position;
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
      return;
    }
    for (const sub of c) visit(sub);
  };
  if ('coordinates' in geom) visit(geom.coordinates);
  else for (const g of geom.geometries) visit(boundsOfGeometry(g));
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

/** Padding that keeps the fitted feature clear of the side panel / bottom sheet. */
function panelPadding(map: MapLibreMap, desktopLeft: number): { top: number; left: number; right: number; bottom: number } {
  const narrow = window.matchMedia('(max-width: 767px)').matches;
  const h = map.getContainer().clientHeight;
  return narrow ? { top: 32, left: 24, right: 24, bottom: Math.round(h * 0.6) + 16 } : { top: 40, left: desktopLeft, right: 40, bottom: 48 };
}

function routesToFC(routes: RouteResponse | null): FeatureCollection<LineString, { mode: RouteMode }> {
  const features: Feature<LineString, { mode: RouteMode }>[] = [];
  if (routes) {
    for (const mode of ROUTE_MODES) {
      const r = routes.routes[mode];
      if (r?.geometry) features.push({ type: 'Feature', geometry: r.geometry, properties: { mode } });
    }
  }
  return { type: 'FeatureCollection', features };
}

function endpointsToFC(origin: PlannerPoint | null, destination: PlannerPoint | null): FeatureCollection<Point, { role: PointRole }> {
  const features: Feature<Point, { role: PointRole }>[] = [];
  if (origin) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [origin.lon, origin.lat] }, properties: { role: 'origin' } });
  if (destination) {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [destination.lon, destination.lat] }, properties: { role: 'destination' } });
  }
  return { type: 'FeatureCollection', features };
}

/** Unknown stretches drawn along the real footpath geometry when the edge ids are known, else start→end. */
function unknownToFC(routes: RouteResponse | null, selected: RouteMode | null, footpaths: FootpathFC | undefined): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  const r = selected && routes ? routes.routes[selected] : null;
  if (r) {
    const byId = new globalThis.Map<number, Feature<LineString>>();
    for (const f of footpaths?.features ?? []) byId.set(f.properties.id, f);
    for (const st of r.unknown_stretches) {
      let found = 0;
      for (const id of st.edge_ids ?? []) {
        const f = byId.get(id);
        if (f) {
          features.push({ type: 'Feature', geometry: f.geometry, properties: {} });
          found++;
        }
      }
      if (found === 0) {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [st.start, st.end] }, properties: { length_m: st.length_m } });
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

function routeBarriersToFC(routes: RouteResponse | null, selected: RouteMode | null): FeatureCollection<Point> {
  const r = selected && routes ? routes.routes[selected] : null;
  return {
    type: 'FeatureCollection',
    features: (r?.barriers ?? []).map((b) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      properties: { id: b.id, severity: b.severity, impassable_for_profile: Boolean(b.impassable_for_profile) },
    })),
  };
}

function pendingToFC(reports: ReportItem[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: reports.map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
      properties: { id: r.id, kind: r.kind, class_id: r.class_id, name_en: r.name_en, name_hi: r.name_hi, severity: r.severity, status: r.status },
    })),
  };
}

function boundsOf(lines: LineString[]): [[number, number], [number, number]] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line.coordinates) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

// ---------- Popup content (built with DOM APIs, never innerHTML) ----------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(dl: HTMLElement, label: string, value: string): void {
  const wrap = el('div', 'popup__row');
  wrap.appendChild(el('dt', undefined, label));
  wrap.appendChild(el('dd', undefined, value));
  dl.appendChild(wrap);
}

/** Rendered-feature properties come back with arrays JSON-encoded as strings. */
function normaliseBarrier(raw: Record<string, unknown>): BarrierProps {
  const p = { ...raw } as unknown as BarrierProps;
  const tags = (raw as { tags?: unknown }).tags;
  if (typeof tags === 'string') {
    try {
      p.tags = JSON.parse(tags) as string[];
    } catch {
      p.tags = [tags];
    }
  } else if (!Array.isArray(tags)) {
    p.tags = [];
  }
  const photos = (raw as { photo_urls?: unknown }).photo_urls;
  if (typeof photos === 'string') {
    try {
      const parsed: unknown = JSON.parse(photos);
      p.photo_urls = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      p.photo_urls = [];
    }
  } else if (Array.isArray(photos)) {
    p.photo_urls = photos.filter((x): x is string => typeof x === 'string');
  } else {
    delete p.photo_urls;
  }
  return p;
}

interface PopupActions {
  reportFixed?: (target: ReportTarget) => void;
}

function barrierPopupContent(p: BarrierProps, lang: Lang, t: TFunction, actions: PopupActions = {}): HTMLElement {
  const root = el('div', 'popup');
  root.lang = lang;
  root.appendChild(el('h3', 'popup__title', localizedName(p, lang)));
  const dl = el('dl', 'popup__list');
  row(dl, t('popup.class'), t(`barrierClass.${p.class}`, { defaultValue: String(p.class) }));
  row(dl, t('severity.label'), `${p.severity} – ${t(`severity.${p.severity}`)}`);
  row(dl, t('popup.status'), t(`status.${p.status}`, { defaultValue: String(p.status) }));
  row(dl, t('popup.permanence'), p.permanent ? t('popup.permanent') : t('popup.temporary'));
  if (p.tags.length > 0) row(dl, t('popup.tags'), p.tags.join(', '));
  if (typeof p.confidence === 'number') row(dl, t('popup.confidence'), `${Math.round(p.confidence * 100)}%`);
  root.appendChild(dl);
  // Photo thumbnails only when the API sends `photo_urls`; older builds do not.
  if (Array.isArray(p.photo_urls) && p.photo_urls.length > 0) {
    const strip = el('div', 'popup__photos');
    for (const url of p.photo_urls.slice(0, 4)) {
      const img = document.createElement('img');
      img.className = 'popup__thumb';
      img.src = photoUrl(url);
      img.alt = t('route.photoAlt', { name: localizedName(p, lang) });
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 72;
      img.height = 72;
      strip.appendChild(img);
    }
    root.appendChild(strip);
  }
  if (p.synthetic) root.appendChild(el('span', 'badge badge--synthetic', t('badge.synthetic')));
  if (actions.reportFixed && p.status === 'active') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--small popup__action';
    btn.textContent = t('report.titleFixed');
    btn.setAttribute('aria-label', `${t('report.titleFixed')}: ${localizedName(p, lang)}`);
    const target: ReportTarget = { id: p.id, class_id: p.class, name_en: p.name_en, name_hi: p.name_hi, severity: p.severity };
    btn.addEventListener('click', () => actions.reportFixed?.(target));
    root.appendChild(btn);
  }
  return root;
}

function pendingPopupContent(raw: Record<string, unknown>, lang: Lang, t: TFunction): HTMLElement {
  const root = el('div', 'popup');
  root.lang = lang;
  const name = localizedName({ name_en: String(raw.name_en ?? ''), name_hi: typeof raw.name_hi === 'string' ? raw.name_hi : null }, lang);
  root.appendChild(el('h3', 'popup__title', name || t('report.pendingMarker')));
  const dl = el('dl', 'popup__list');
  row(dl, t('popup.kind'), raw.kind === 'fixed' ? t('validate.kindFixed') : t('validate.kindBarrier'));
  row(dl, t('popup.class'), t(`barrierClass.${String(raw.class_id)}`, { defaultValue: String(raw.class_id) }));
  const sev = Number(raw.severity);
  if (Number.isFinite(sev)) row(dl, t('severity.label'), `${sev} – ${t(`report.severityWord.${sev}`)}`);
  row(dl, t('popup.status'), t('validate.status.pending'));
  root.appendChild(dl);
  root.appendChild(el('p', 'popup__note', t('report.pendingMarker')));
  return root;
}

function anchorPopupContent(p: AnchorProps, lang: Lang, t: TFunction): HTMLElement {
  const root = el('div', 'popup');
  root.lang = lang;
  root.appendChild(el('h3', 'popup__title', localizedName(p, lang)));
  const dl = el('dl', 'popup__list');
  row(dl, t('popup.kind'), t(`anchorKind.${p.kind}`, { defaultValue: String(p.kind) }));
  row(dl, t('popup.status'), p.verified ? t('popup.verified') : t('popup.unverified'));
  root.appendChild(dl);
  if (p.synthetic) root.appendChild(el('span', 'badge badge--synthetic', t('badge.synthetic')));
  return root;
}

function demoPopupContent(p: DemoProps, lang: Lang, t: TFunction): HTMLElement {
  const root = el('div', 'popup');
  root.lang = lang;
  const title = p.role === 'destination' ? localizedName(p, lang) : t(`demo.${p.role}`);
  root.appendChild(el('h3', 'popup__title', title));
  const dl = el('dl', 'popup__list');
  row(dl, t('popup.kind'), t(`demo.${p.role}`));
  if (p.role === 'path') row(dl, t('demo.length'), `${Math.round(p.length_m)} ${t('units.m')}`);
  root.appendChild(dl);
  root.appendChild(el('span', 'badge badge--synthetic', t('badge.synthetic')));
  return root;
}

function formatTime(iso: string | null, lang: Lang): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

/** Rendered-feature properties lose `null` (they arrive as missing); normalise the optional ones. */
function normaliseImage(raw: Record<string, unknown>): ImageProps {
  const p = { ...raw } as unknown as ImageProps;
  p.heading_deg = typeof raw.heading_deg === 'number' ? raw.heading_deg : null;
  p.captured_at = typeof raw.captured_at === 'string' ? raw.captured_at : null;
  p.attribution = typeof raw.attribution === 'string' && raw.attribution.length > 0 ? raw.attribution : null;
  p.session_id = typeof raw.session_id === 'string' && raw.session_id.length > 0 ? raw.session_id : null;
  p.has_photo = raw.has_photo === true || raw.has_photo === 'true';
  p.synthetic = raw.synthetic === true || raw.synthetic === 'true';
  return p;
}

function imagePopupContent(p: ImageProps, lang: Lang, t: TFunction): HTMLElement {
  const root = el('div', 'popup');
  root.lang = lang;
  root.appendChild(el('h3', 'popup__title', t(`images.source.${p.source}`, { defaultValue: String(p.source) })));
  const dl = el('dl', 'popup__list');
  const time = formatTime(p.captured_at, lang);
  row(dl, t('images.time'), time ?? t('images.unknown'));
  row(dl, t('images.heading'), p.heading_deg === null ? t('images.unknown') : `${Math.round(p.heading_deg)}°`);
  if (typeof p.hfov_deg === 'number') row(dl, t('images.hfov'), `${Math.round(p.hfov_deg)}°`);
  if (p.session_id) row(dl, t('images.session'), p.session_id);
  root.appendChild(dl);
  // Attribution must always be visible for Mapillary imagery.
  const attribution = p.attribution ?? (p.source === 'mapillary' ? t('images.mapillaryAttribution') : null);
  if (attribution) root.appendChild(el('p', 'popup__attribution', attribution));
  if (p.has_photo) {
    const img = document.createElement('img');
    img.className = 'popup__photo';
    img.src = imagePhotoUrl(p.id);
    img.alt = t('images.photoAlt');
    img.loading = 'lazy';
    img.decoding = 'async';
    root.appendChild(img);
  } else {
    root.appendChild(el('p', 'popup__note', t('images.noPhoto')));
  }
  if (p.synthetic) root.appendChild(el('span', 'badge badge--synthetic', t('badge.synthetic')));
  return root;
}

function coveragePopupContent(p: CoverageProps, lang: Lang, t: TFunction): HTMLElement {
  const root = el('div', 'popup');
  root.lang = lang;
  const observed = p.observed === true || (p.observed as unknown) === 'true';
  root.appendChild(el('h3', 'popup__title', t('layers.coverage')));
  const dl = el('dl', 'popup__list');
  row(dl, t('popup.status'), observed ? t('coverage.observed') : t('coverage.unobserved'));
  const n = typeof p.n_images === 'number' ? p.n_images : Number(p.n_images) || 0;
  row(dl, t('coverage.nImages'), String(n));
  if (p.source) row(dl, t('coverage.sourceLabel'), t(`coverage.source.${p.source}`, { defaultValue: String(p.source) }));
  if (p.side) row(dl, t('coverage.sideLabel'), t(`coverage.side.${p.side}`, { defaultValue: String(p.side) }));
  const last = formatTime(typeof p.last_observed_at === 'string' ? p.last_observed_at : null, lang);
  if (last) row(dl, t('coverage.lastObserved'), last);
  root.appendChild(dl);
  if (p.source === 'seed') root.appendChild(el('span', 'badge badge--synthetic', t('coverage.seeded')));
  return root;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- Component ----------

export default function MapView({
  zone,
  zoneSettled,
  data,
  visible,
  lang,
  selection,
  onBasemapError,
  routes,
  selectedRoute,
  onSelectRoute,
  origin,
  destination,
  pickMode,
  onPick,
  pendingReports,
  mission,
  onReportFixed,
  reach,
  reachFixed,
  reachFocus,
}: MapViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [ready, setReady] = useState(false);

  // Latest language / translator / callbacks for event handlers registered once.
  const langRef = useRef(lang);
  const tRef = useRef(t);
  const errorRef = useRef(onBasemapError);
  const pickRef = useRef(pickMode);
  const onPickRef = useRef(onPick);
  const onSelectRouteRef = useRef(onSelectRoute);
  const onReportFixedRef = useRef(onReportFixed);
  langRef.current = lang;
  tRef.current = t;
  errorRef.current = onBasemapError;
  pickRef.current = pickMode;
  onPickRef.current = onPick;
  onSelectRouteRef.current = onSelectRoute;
  onReportFixedRef.current = onReportFixed;

  /** Popup actions close the popup first so focus does not end up in a removed node. */
  const popupActions = (): PopupActions => ({
    reportFixed: (target) => {
      popupRef.current?.remove();
      popupRef.current = null;
      onReportFixedRef.current(target);
    },
  });

  const openPopup = (map: MapLibreMap, lngLat: [number, number], content: HTMLElement) => {
    if (pickRef.current) return; // the click is setting a planner point instead
    popupRef.current?.remove();
    const popup = new Popup({ closeButton: true, closeOnClick: true, maxWidth: '300px', focusAfterOpen: true })
      .setLngLat(lngLat)
      .setDOMContent(content)
      .addTo(map);
    popupRef.current = popup;
  };

  // Create the map once the zone request has settled.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current || !zoneSettled) return;

    const map = new MapLibreMap({
      container,
      style: zone ? zone.basemap.style_url : EMPTY_STYLE,
      center: zone ? [zone.center.lon, zone.center.lat] : [0, 0],
      zoom: zone ? 15 : 1,
      attributionControl: false,
      locale: {
        'Popup.Close': tRef.current('popup.close'),
        'NavigationControl.ZoomIn': tRef.current('map.zoomIn'),
        'NavigationControl.ZoomOut': tRef.current('map.zoomOut'),
      },
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: false,
        customAttribution: zone ? [zone.attribution.osm, zone.basemap.attribution] : [],
      }),
      'bottom-right',
    );
    map.getCanvas().setAttribute('aria-label', tRef.current('map.label'));

    if (zone) {
      map.fitBounds(
        [
          [zone.bbox.west, zone.bbox.south],
          [zone.bbox.east, zone.bbox.north],
        ],
        { padding: 24, duration: 0 },
      );
    }

    map.on('error', (e) => {
      // Style/tile failures surface here; data layers are added only after 'load'.
      if (!map.isStyleLoaded()) errorRef.current();
      console.warn('[map]', e.error?.message ?? e);
    });

    map.once('load', () => {
      addRouteSources(map);
      addSourcesAndLayers(map, langRef.current);
      addRouteTopLayers(map);

      const pointer = (on: boolean) => () => {
        if (pickRef.current) return;
        map.getCanvas().style.cursor = on ? 'pointer' : '';
      };
      for (const id of [...POINT_CLICK_LAYERS, ...ROUTE_CLICK_LAYERS]) {
        map.on('mouseenter', id, pointer(true));
        map.on('mouseleave', id, pointer(false));
      }

      // Pick-on-map: while a planner field is in pick mode, any click sets that point and nothing else.
      map.on('click', (e) => {
        const role = pickRef.current;
        if (!role) return;
        onPickRef.current(role, e.lngLat.lat, e.lngLat.lng);
      });
      // Clicking a compared route line selects its card.
      map.on('click', 'route-samaan', () => {
        if (!pickRef.current) onSelectRouteRef.current('samaan');
      });
      map.on('click', 'route-naive', () => {
        if (!pickRef.current) onSelectRouteRef.current('naive_accessible');
      });
      map.on('click', 'route-shortest', () => {
        if (!pickRef.current) onSelectRouteRef.current('shortest');
      });

      const first = (e: MapLayerMouseEvent): MapGeoJSONFeature | undefined => e.features?.[0];
      const coords = (f: MapGeoJSONFeature): [number, number] => {
        const c = (f.geometry as Point).coordinates;
        return [c[0], c[1]];
      };

      map.on('click', 'barriers', (e) => {
        const f = first(e);
        if (!f) return;
        openPopup(map, coords(f), barrierPopupContent(normaliseBarrier(f.properties), langRef.current, tRef.current, popupActions()));
      });
      map.on('click', 'pending-reports', (e) => {
        const f = first(e);
        if (!f) return;
        openPopup(map, coords(f), pendingPopupContent(f.properties, langRef.current, tRef.current));
      });
      map.on('click', 'anchors', (e) => {
        const f = first(e);
        if (!f) return;
        openPopup(map, coords(f), anchorPopupContent(f.properties as unknown as AnchorProps, langRef.current, tRef.current));
      });
      map.on('click', 'demo-endpoints', (e) => {
        const f = first(e);
        if (!f) return;
        openPopup(map, coords(f), demoPopupContent(f.properties as unknown as DemoProps, langRef.current, tRef.current));
      });
      map.on('click', 'demo-path', (e) => {
        const f = first(e);
        if (!f) return;
        openPopup(map, [e.lngLat.lng, e.lngLat.lat], demoPopupContent(f.properties as unknown as DemoProps, langRef.current, tRef.current));
      });
      map.on('click', 'images', (e) => {
        const f = first(e);
        if (!f) return;
        openPopup(map, coords(f), imagePopupContent(normaliseImage(f.properties), langRef.current, tRef.current));
      });
      const onCoverageClick = (e: MapLayerMouseEvent) => {
        const f = first(e);
        if (!f) return;
        // Points sit above the coverage bands; let their own handlers win.
        const pointLayers = POINT_CLICK_LAYERS.filter((id) => map.getLayer(id));
        if (map.queryRenderedFeatures(e.point, { layers: pointLayers }).length > 0) return;
        openPopup(
          map,
          [e.lngLat.lng, e.lngLat.lat],
          coveragePopupContent(f.properties as unknown as CoverageProps, langRef.current, tRef.current),
        );
      };
      map.on('click', 'coverage-observed', onCoverageClick);
      map.on('click', 'coverage-unobserved', onCoverageClick);

      setReady(true);
    });

    return () => {
      popupRef.current?.remove();
      popupRef.current = null;
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, zoneSettled]);

  // Push data into sources whenever it changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const key of LAYER_KEYS) {
      const src = map.getSource(key) as GeoJSONSource | undefined;
      src?.setData((data[key] as FeatureCollection | undefined) ?? EMPTY_FC);
    }
  }, [data, ready]);

  // Layer visibility toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const key of LAYER_KEYS) {
      for (const id of LAYER_IDS[key]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible[key] ? 'visible' : 'none');
      }
    }
  }, [visible, ready]);

  // Route planner: lines, A/B pins, unknown stretches and barrier rings of the highlighted route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('routes') as GeoJSONSource | undefined)?.setData(routesToFC(routes));
    (map.getSource('route-unknown') as GeoJSONSource | undefined)?.setData(unknownToFC(routes, selectedRoute, data.footpaths));
    (map.getSource('route-barriers') as GeoJSONSource | undefined)?.setData(routeBarriersToFC(routes, selectedRoute));
    // Dim the two routes that are not selected (opacity + the selected one stays full width).
    for (const mode of ROUTE_MODES) {
      const dim = selectedRoute !== null && selectedRoute !== mode && routes !== null;
      for (const id of ROUTE_LINE_LAYERS[mode]) {
        if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', dim ? 0.3 : 1);
      }
    }
  }, [routes, selectedRoute, data.footpaths, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('route-endpoints') as GeoJSONSource | undefined)?.setData(endpointsToFC(origin, destination));
  }, [origin, destination, ready]);

  // Fit the map to the selected route (or to all three when nothing is selected yet).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !routes) return;
    const lines: LineString[] = [];
    const target = selectedRoute ? routes.routes[selectedRoute] : null;
    if (target) lines.push(target.geometry);
    else for (const mode of ROUTE_MODES) if (routes.routes[mode]) lines.push(routes.routes[mode]!.geometry);
    const b = boundsOf(lines);
    if (!b) return;
    const narrow = window.matchMedia('(max-width: 767px)').matches;
    const h = map.getContainer().clientHeight;
    const padding = narrow
      ? { top: 32, left: 24, right: 24, bottom: Math.round(h * 0.6) + 16 }
      : { top: 40, left: 420, right: 40, bottom: Math.round(h * 0.46) + 24 };
    map.fitBounds(b, { padding, duration: prefersReducedMotion() ? 0 : 700, maxZoom: 18 });
  }, [routes, selectedRoute, ready]);

  // Pending reports from this session.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('pending-reports') as GeoJSONSource | undefined)?.setData(pendingToFC(pendingReports));
  }, [pendingReports, ready]);

  // Highlighted mission: draw it and fit the map to it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc: FeatureCollection = { type: 'FeatureCollection', features: mission ? [mission] : [] };
    (map.getSource('missions') as GeoJSONSource | undefined)?.setData(fc);
    if (!mission) return;
    const b = boundsOf([mission.geometry]);
    if (b) map.fitBounds(b, { padding: 60, duration: prefersReducedMotion() ? 0 : 700, maxZoom: 17.5 });
  }, [mission, ready]);

  // Reach Gap: the three hulls, the anchor star and the ranked fix pins.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('reach-walker') as GeoJSONSource | undefined)?.setData(hullToFC(reach?.walker.hull));
    (map.getSource('reach-target') as GeoJSONSource | undefined)?.setData(hullToFC(reach?.target.hull));
    (map.getSource('reach-simulated') as GeoJSONSource | undefined)?.setData(hullToFC(reach?.simulated?.hull));
    (map.getSource('reach-anchor') as GeoJSONSource | undefined)?.setData(reachAnchorToFC(reach, lang, t('reach.anchorPin')));
  }, [reach, lang, t, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('reach-fixes') as GeoJSONSource | undefined)?.setData(reachFixesToFC(reach, reachFixed));
  }, [reach, reachFixed, ready]);

  // Fit the map to the walker hull when a (new) result arrives. Simulations keep the same walker hull,
  // so toggling a fix does not move the map the user may have panned.
  const reachBoundsKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!reach) {
      reachBoundsKeyRef.current = null;
      return;
    }
    const b = boundsOfGeometry(reach.walker.hull) ?? boundsOfGeometry(reach.target.hull);
    const key = b ? `${reach.anchor.id}|${b.flat().join(',')}` : `${reach.anchor.id}|anchor`;
    if (key === reachBoundsKeyRef.current) return;
    reachBoundsKeyRef.current = key;
    const duration = prefersReducedMotion() ? 0 : 700;
    if (b) map.fitBounds(b, { padding: panelPadding(map, 480), duration, maxZoom: 17 });
    else map.flyTo({ center: [reach.anchor.lon, reach.anchor.lat], zoom: 16, duration, padding: panelPadding(map, 480), essential: true });
  }, [reach, ready]);

  // Grow the simulated blob in (fill-opacity 0 -> target over ~600 ms); instant under reduced motion.
  const simHull = reach?.simulated?.hull ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer('reach-simulated-fill')) return;
    const target = REACH_STYLES.simulated.fillOpacity;
    if (!simHull || prefersReducedMotion()) {
      map.setPaintProperty('reach-simulated-fill', 'fill-opacity', target);
      map.setPaintProperty('reach-simulated-line', 'line-opacity', 1);
      return;
    }
    map.setPaintProperty('reach-simulated-fill', 'fill-opacity', 0);
    map.setPaintProperty('reach-simulated-line', 'line-opacity', 0);
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / SIM_GROW_MS);
      const eased = 1 - (1 - p) * (1 - p);
      if (map.getLayer('reach-simulated-fill')) {
        map.setPaintProperty('reach-simulated-fill', 'fill-opacity', target * eased);
        map.setPaintProperty('reach-simulated-line', 'line-opacity', eased);
      }
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [simHull, ready]);

  // "Show" on a fix row: fly to the barrier and open its popup when the barriers layer knows it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !reachFocus) return;
    const target: [number, number] = [reachFocus.lon, reachFocus.lat];
    map.flyTo({
      center: target,
      zoom: Math.max(map.getZoom(), 17),
      duration: prefersReducedMotion() ? 0 : 900,
      padding: panelPadding(map, 480),
      essential: true,
    });
    const feature = data.barriers?.features.find((f) => f.properties.id === reachFocus.barrierId);
    if (feature) openPopup(map, target, barrierPopupContent(feature.properties, langRef.current, tRef.current, popupActions()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachFocus, ready]);

  // Pulse the barrier rings (static when the user prefers reduced motion).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const hasRings = Boolean(selectedRoute && routes?.routes[selectedRoute]?.barriers.length);
    if (!hasRings || prefersReducedMotion()) {
      if (map.getLayer('route-barriers-ring')) {
        map.setPaintProperty('route-barriers-ring', 'circle-radius', RING_RADIUS);
        map.setPaintProperty('route-barriers-ring', 'circle-stroke-opacity', 0.9);
      }
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const phase = ((now - start) % 1400) / 1400;
      const wave = (Math.sin(phase * Math.PI * 2) + 1) / 2;
      if (map.getLayer('route-barriers-ring')) {
        map.setPaintProperty('route-barriers-ring', 'circle-radius', RING_RADIUS - 4 + wave * 8);
        map.setPaintProperty('route-barriers-ring', 'circle-stroke-opacity', 0.55 + wave * 0.45);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [routes, selectedRoute, ready]);

  // Pick mode: crosshair cursor and a canvas label that says what a click does.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = pickMode ? 'crosshair' : '';
    const label = pickMode ? `${t('map.label')}. ${t('route.pickHint', { field: t(`route.${pickMode}`).toLocaleLowerCase() })}` : t('map.label');
    map.getCanvas().setAttribute('aria-label', label);
  }, [pickMode, ready, t, lang]);

  // Language: relabel anchors, canvas label; close any open popup (its text is stale).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (map.getLayer('anchors-label')) map.setLayoutProperty('anchors-label', 'text-field', ['get', nameProp(lang)]);
    if (map.getLayer('missions-label')) map.setLayoutProperty('missions-label', 'text-field', ['get', nameProp(lang)]);
    // (The reach anchor label is rebuilt from `lang` by its own data effect.)
    popupRef.current?.remove();
    popupRef.current = null;
  }, [lang, ready]);

  // Fly to a barrier chosen from the list and open its popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !selection) return;
    const [lon, lat] = selection.feature.geometry.coordinates;
    const target: [number, number] = [lon, lat];
    map.flyTo({
      center: target,
      zoom: Math.max(map.getZoom(), 17),
      duration: prefersReducedMotion() ? 0 : 900,
      essential: true,
    });
    openPopup(map, target, barrierPopupContent(selection.feature.properties, langRef.current, tRef.current, popupActions()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, ready]);

  return <div ref={containerRef} className="map" role="region" aria-label={t('map.label')} />;
}
