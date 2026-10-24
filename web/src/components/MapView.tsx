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
import type { FeatureCollection, Point } from 'geojson';
import {
  localizedName,
  LAYER_KEYS,
  type AnchorProps,
  type BarrierFeature,
  type BarrierProps,
  type DemoProps,
  type LayerData,
  type LayerKey,
  type Zone,
} from '../api';
import type { Lang } from '../i18n';

export interface BarrierSelection {
  feature: BarrierFeature;
  /** Changes on every selection so re-selecting the same barrier re-flies. */
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
};

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
  return p;
}

function barrierPopupContent(p: BarrierProps, lang: Lang, t: TFunction): HTMLElement {
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
  if (p.synthetic) root.appendChild(el('span', 'badge badge--synthetic', t('badge.synthetic')));
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

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- Component ----------

export default function MapView({ zone, zoneSettled, data, visible, lang, selection, onBasemapError }: MapViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const [ready, setReady] = useState(false);

  // Latest language / translator for event handlers registered once.
  const langRef = useRef(lang);
  const tRef = useRef(t);
  const errorRef = useRef(onBasemapError);
  langRef.current = lang;
  tRef.current = t;
  errorRef.current = onBasemapError;

  const openPopup = (map: MapLibreMap, lngLat: [number, number], content: HTMLElement) => {
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
      addSourcesAndLayers(map, langRef.current);

      const pointer = (on: boolean) => () => {
        map.getCanvas().style.cursor = on ? 'pointer' : '';
      };
      for (const id of ['barriers', 'anchors', 'demo-endpoints']) {
        map.on('mouseenter', id, pointer(true));
        map.on('mouseleave', id, pointer(false));
      }

      const first = (e: MapLayerMouseEvent): MapGeoJSONFeature | undefined => e.features?.[0];
      const coords = (f: MapGeoJSONFeature): [number, number] => {
        const c = (f.geometry as Point).coordinates;
        return [c[0], c[1]];
      };

      map.on('click', 'barriers', (e) => {
        const f = first(e);
        if (!f) return;
        openPopup(map, coords(f), barrierPopupContent(normaliseBarrier(f.properties), langRef.current, tRef.current));
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

  // Language: relabel anchors, canvas label; close any open popup (its text is stale).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (map.getLayer('anchors-label')) map.setLayoutProperty('anchors-label', 'text-field', ['get', nameProp(lang)]);
    map.getCanvas().setAttribute('aria-label', t('map.label'));
    popupRef.current?.remove();
    popupRef.current = null;
  }, [lang, ready, t]);

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
    openPopup(map, target, barrierPopupContent(selection.feature.properties, langRef.current, tRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, ready]);

  return <div ref={containerRef} className="map" role="region" aria-label={t('map.label')} />;
}
