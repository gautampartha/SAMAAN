// Barrier map for the console: red = needs a job, amber = job open, green = fixed; seed barriers
// drawn hollow. Click a red dot to open the assign dialog.
import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import { OPEN_STATUSES, type BarrierRow, type Zone } from './adminApi';
import type { Lang } from './util';

interface Props {
  zone: Zone | null;
  barriers: BarrierRow[];
  lang: Lang;
  onPick: (b: BarrierRow) => void;
  label: string;
}

function stateOf(b: BarrierRow): 'unassigned' | 'progress' | 'fixed' {
  if (b.status !== 'active') return 'fixed';
  return b.work_order && OPEN_STATUSES.includes(b.work_order.status) ? 'progress' : 'unassigned';
}

export default function AdminMap({ zone, barriers, lang, onPick, label }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyRef = useRef(false);
  const rowsRef = useRef<BarrierRow[]>(barriers);
  rowsRef.current = barriers;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!zone || !el.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: zone.basemap.style_url,
      bounds: [
        [zone.bbox.west, zone.bbox.south],
        [zone.bbox.east, zone.bbox.north],
      ],
      fitBoundsOptions: { padding: 20 },
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    map.on('load', () => {
      map.addSource('b', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'b',
        type: 'circle',
        source: 'b',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 5, 18, 10],
          'circle-color': ['match', ['get', 'state'], 'unassigned', '#d93025', 'progress', '#f29900', '#188038'],
          'circle-opacity': ['case', ['get', 'synthetic'], 0.25, 0.95],
          'circle-stroke-color': ['match', ['get', 'state'], 'unassigned', '#d93025', 'progress', '#b06000', '#0d652d'],
          'circle-stroke-width': 2,
        },
      });
      map.on('click', 'b', (e) => {
        const id = Number(e.features?.[0]?.properties?.id);
        const row = rowsRef.current.find((r) => r.id === id);
        if (row && stateOf(row) === 'unassigned') pickRef.current(row);
      });
      map.on('mouseenter', 'b', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'b', () => (map.getCanvas().style.cursor = ''));
      readyRef.current = true;
      draw();
    });
    function draw() {
      const src = map.getSource('b') as GeoJSONSource | undefined;
      src?.setData({
        type: 'FeatureCollection',
        features: rowsRef.current.map((b) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
          properties: { id: b.id, state: stateOf(b), synthetic: b.synthetic },
        })),
      });
    }
    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, [zone]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource('b') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: barriers.map((b) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
        properties: { id: b.id, state: stateOf(b), synthetic: b.synthetic },
      })),
    });
  }, [barriers, lang]);

  return <div ref={el} className="adm-map" role="img" aria-label={label} />;
}
