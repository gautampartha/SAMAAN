import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, LAYER_KEYS, type BarrierFeature, type LayerData, type LayerKey, type Zone } from './api';
import { toLang, type Lang } from './i18n';
import Header from './components/Header';
import Legend from './components/Legend';
import BarrierList from './components/BarrierList';
import MapView, { type BarrierSelection } from './components/MapView';
import CapturePage from './components/CapturePage';
import { useHashRoute } from './router';

type Theme = 'auto' | 'normal' | 'high-contrast';
const THEME_STORAGE_KEY = 'samaan.theme';

type LoadStatus = 'loading' | 'ok' | 'partial' | 'error';

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'normal' || v === 'high-contrast') return v;
  } catch {
    /* ignore */
  }
  return 'auto';
}

function systemPrefersHighContrast(): boolean {
  return window.matchMedia('(prefers-contrast: more)').matches;
}

function isNarrow(): boolean {
  return window.matchMedia('(max-width: 767px)').matches;
}

const DEFAULT_VISIBLE: Record<LayerKey, boolean> = {
  footpaths: true,
  barriers: true,
  coverage: false,
  anchors: true,
  demo: true,
  images: false,
};

export default function App() {
  const { t, i18n } = useTranslation();
  const lang: Lang = toLang(i18n.language);
  const route = useHashRoute();

  const [zone, setZone] = useState<Zone | null>(null);
  const [zoneSettled, setZoneSettled] = useState(false);
  const [synthetic, setSynthetic] = useState(false);
  const [data, setData] = useState<LayerData>({});
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [failed, setFailed] = useState<LayerKey[]>([]);
  const [basemapError, setBasemapError] = useState(false);

  const [visible, setVisible] = useState<Record<LayerKey, boolean>>(DEFAULT_VISIBLE);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [legendOpen, setLegendOpen] = useState(() => !isNarrow());
  const [listOpen, setListOpen] = useState(false);
  const [selection, setSelection] = useState<BarrierSelection | null>(null);

  // ---- Data loading: everything in parallel; partial failures keep the rest. ----
  useEffect(() => {
    const ac = new AbortController();
    const s = ac.signal;
    (async () => {
      const [h, z, fp, ba, cov, an, de, im] = await Promise.allSettled([
        api.health(s),
        api.zone(s),
        api.footpaths(s),
        api.barriers(s),
        api.coverage(s),
        api.anchors(s),
        api.demo(s),
        api.images(s),
      ]);
      if (s.aborted) return;

      if (h.status === 'fulfilled') setSynthetic(Boolean(h.value.synthetic));
      setZone(z.status === 'fulfilled' ? z.value : null);
      setZoneSettled(true);

      const next: LayerData = {};
      const failedKeys: LayerKey[] = [];
      const pick = <K extends LayerKey>(key: K, r: PromiseSettledResult<NonNullable<LayerData[K]>>) => {
        if (r.status === 'fulfilled') next[key] = r.value;
        else failedKeys.push(key);
      };
      pick('footpaths', fp);
      pick('barriers', ba);
      pick('coverage', cov);
      pick('anchors', an);
      pick('demo', de);
      pick('images', im);

      setData(next);
      setFailed(failedKeys);
      const everythingFailed = z.status === 'rejected' && failedKeys.length === LAYER_KEYS.length;
      setStatus(everythingFailed ? 'error' : failedKeys.length > 0 ? 'partial' : 'ok');
    })().catch((err: unknown) => {
      if (!s.aborted) {
        console.error(err);
        setZoneSettled(true);
        setStatus('error');
      }
    });
    return () => ac.abort();
  }, []);

  // ---- Theme (high contrast) ----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      if (theme === 'auto') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const highContrast = theme === 'high-contrast' || (theme === 'auto' && systemPrefersHighContrast());
  const toggleContrast = useCallback(() => {
    setTheme(highContrast ? 'normal' : 'high-contrast');
  }, [highContrast]);

  const changeLang = useCallback(
    (next: Lang) => {
      void i18n.changeLanguage(next);
    },
    [i18n],
  );

  // On phones the two panels are bottom sheets, so only one is open at a time.
  const toggleLegend = useCallback(() => {
    setLegendOpen((open) => {
      if (!open && isNarrow()) setListOpen(false);
      return !open;
    });
  }, []);
  const toggleList = useCallback(() => {
    setListOpen((open) => {
      if (!open && isNarrow()) setLegendOpen(false);
      return !open;
    });
  }, []);

  const toggleLayer = useCallback((key: LayerKey) => {
    setVisible((v) => ({ ...v, [key]: !v[key] }));
  }, []);

  const selectBarrier = useCallback((feature: BarrierFeature) => {
    setSelection({ feature, nonce: Date.now() });
    setVisible((v) => (v.barriers ? v : { ...v, barriers: true }));
    if (isNarrow()) setListOpen(false);
  }, []);

  const barriers = useMemo(() => data.barriers?.features ?? [], [data.barriers]);
  const footpathCount = data.footpaths?.features.length ?? 0;

  const statusText =
    status === 'loading'
      ? t('load.loading')
      : status === 'error'
        ? t('load.error')
        : status === 'partial'
          ? t('load.partial', { layers: failed.map((k) => t(`layers.${k}`)).join(', ') })
          : t('load.loaded', { barriers: barriers.length, footpaths: footpathCount });

  const statusNode = (
    <p className={`statusline statusline--${status}`} role="status" aria-live="polite">
      {statusText}
      {basemapError && <span className="statusline__extra"> {t('load.basemap')}</span>}
    </p>
  );

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {t('skip.toContent')}
      </a>
      <Header
        zone={zone}
        lang={lang}
        onLangChange={changeLang}
        highContrast={highContrast}
        onToggleContrast={toggleContrast}
        legendOpen={legendOpen}
        onToggleLegend={toggleLegend}
        listOpen={listOpen}
        onToggleList={toggleList}
        synthetic={synthetic}
        status={route === 'map' ? statusNode : null}
        route={route}
      />

      {route === 'capture' ? (
        <main id="main" className="main main--page" tabIndex={-1}>
          <CapturePage />
        </main>
      ) : (
        <main id="main" className="main" tabIndex={-1}>
          <MapView
            zone={zone}
            zoneSettled={zoneSettled}
            data={data}
            visible={visible}
            lang={lang}
            selection={selection}
            onBasemapError={() => setBasemapError(true)}
          />

          {status === 'error' && (
            <div className="banner banner--error" role="alert">
              {t('load.error')}
            </div>
          )}

          {legendOpen && (
            <aside id="panel-legend" className="panel panel--legend" aria-labelledby="legend-title">
              <Legend visible={visible} onToggle={toggleLayer} onClose={toggleLegend} />
            </aside>
          )}

          {listOpen && (
            <aside id="panel-list" className="panel panel--list" aria-labelledby="list-title">
              <BarrierList
                barriers={barriers}
                lang={lang}
                selectedId={selection?.feature.properties.id ?? null}
                onSelect={selectBarrier}
                onClose={toggleList}
              />
            </aside>
          )}
        </main>
      )}
    </div>
  );
}
