import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { api, LAYER_KEYS, type BarrierFeature, type LayerData, type LayerKey, type Zone } from './api';
import { toLang, type Lang } from './i18n';
import Header from './components/Header';
import Legend from './components/Legend';
import BarrierList from './components/BarrierList';
import MapView, { type BarrierSelection } from './components/MapView';
import CapturePage from './components/CapturePage';
import RoutePlanner from './components/RoutePlanner';
import RouteCompare from './components/RouteCompare';
import { useHashRoute } from './router';
import { formatCoords, useRoutePlanner, type PointRole } from './routePlanner';

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

/**
 * Panel focus management: when a panel opens, focus moves to its heading; when the
 * user closes it, focus returns to the button that opened it. The initial render is
 * skipped so a panel that is open by default does not steal focus on load.
 */
function usePanelFocus(open: boolean, heading: RefObject<HTMLElement>, opener: RefObject<HTMLElement>): void {
  const prev = useRef<boolean | null>(null);
  useEffect(() => {
    const was = prev.current;
    prev.current = open;
    if (was === null) return;
    if (open && !was) {
      const id = window.setTimeout(() => heading.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    if (!open && was) opener.current?.focus();
    return undefined;
  }, [open, heading, opener]);
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

  // ---- Route planner ----
  const planner = useRoutePlanner();
  const plannerOpen = planner.state.open;
  const pickMode = planner.state.pickMode;
  // Stable actions (useCallback / setState inside the hook) for dependency lists.
  const { setOpen: setPlannerOpen, setPoint: setPlannerPoint, setPickMode, select: selectRoute } = planner;
  const plannerBtnRef = useRef<HTMLButtonElement>(null);
  const legendBtnRef = useRef<HTMLButtonElement>(null);
  const listBtnRef = useRef<HTMLButtonElement>(null);
  const plannerHeadingRef = useRef<HTMLHeadingElement>(null);
  const legendHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  usePanelFocus(plannerOpen, plannerHeadingRef, plannerBtnRef);
  usePanelFocus(legendOpen, legendHeadingRef, legendBtnRef);
  usePanelFocus(listOpen, listHeadingRef, listBtnRef);

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

  // On phones the panels are bottom sheets, so only one is open at a time. The
  // planner and the barrier list share the left column on desktop, so they are
  // exclusive there too.
  const toggleLegend = useCallback(() => {
    setLegendOpen((open) => {
      if (!open && isNarrow()) {
        setListOpen(false);
        setPlannerOpen(false);
      }
      return !open;
    });
  }, [setPlannerOpen]);
  const toggleList = useCallback(() => {
    setListOpen((open) => {
      if (!open) {
        setPlannerOpen(false);
        if (isNarrow()) setLegendOpen(false);
      }
      return !open;
    });
  }, [setPlannerOpen]);
  const togglePlanner = useCallback(() => {
    const next = !plannerOpen;
    setPlannerOpen(next);
    if (next) {
      setListOpen(false);
      if (isNarrow()) setLegendOpen(false);
    } else {
      setPickMode(null);
    }
  }, [plannerOpen, setPlannerOpen, setPickMode]);

  // A map pick sets the planner point and ends pick mode.
  const onPick = useCallback(
    (role: PointRole, lat: number, lon: number) => {
      setPlannerPoint(role, { lat, lon, label: formatCoords(lat, lon) });
      // On a phone the sheet hides the map while picking; bring it back once the point is set.
      if (isNarrow()) setPlannerOpen(true);
    },
    [setPlannerPoint, setPlannerOpen],
  );
  // While picking on a phone, close the sheet so the map is tappable.
  useEffect(() => {
    if (pickMode && isNarrow()) setPlannerOpen(false);
  }, [pickMode, setPlannerOpen]);

  // When a comparison arrives, hide the static demo layer (its dashed purple line would be confused with SAMAAN's).
  const result = planner.state.result;
  useEffect(() => {
    if (result) setVisible((v) => (v.demo ? { ...v, demo: false } : v));
  }, [result]);

  const onPanelKeyDown = (close: () => void) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

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
        plannerOpen={plannerOpen}
        onTogglePlanner={togglePlanner}
        plannerBtnRef={plannerBtnRef}
        legendBtnRef={legendBtnRef}
        listBtnRef={listBtnRef}
        synthetic={synthetic}
        status={route === 'map' ? statusNode : null}
        route={route}
      />

      {route === 'capture' ? (
        <main id="main" className="main main--page" tabIndex={-1}>
          <CapturePage />
        </main>
      ) : (
        <main id="main" className={`main${plannerOpen ? ' main--planner' : ''}`} tabIndex={-1}>
          <MapView
            zone={zone}
            zoneSettled={zoneSettled}
            data={data}
            visible={visible}
            lang={lang}
            selection={selection}
            onBasemapError={() => setBasemapError(true)}
            routes={result}
            selectedRoute={planner.state.selected}
            onSelectRoute={selectRoute}
            origin={planner.state.origin}
            destination={planner.state.destination}
            pickMode={pickMode}
            onPick={onPick}
          />

          {pickMode && !plannerOpen && (
            <div className="banner banner--pick" role="status" aria-live="polite">
              {t('route.pickHint', { field: t(`route.${pickMode}`).toLocaleLowerCase() })}
              <button type="button" className="btn" onClick={() => setPickMode(null)}>
                {t('panels.close')}
              </button>
            </div>
          )}

          {status === 'error' && (
            <div className="banner banner--error" role="alert">
              {t('load.error')}
            </div>
          )}

          {plannerOpen && (
            <div className="route-dock" onKeyDown={onPanelKeyDown(togglePlanner)}>
              <aside id="panel-route" className="panel panel--route" aria-labelledby="route-title">
                <RoutePlanner planner={planner} lang={lang} onClose={togglePlanner} headingRef={plannerHeadingRef} />
              </aside>
              {result && (
                <aside className="panel panel--compare" aria-labelledby="compare-title">
                  <RouteCompare result={result} selected={planner.state.selected} lang={lang} onSelect={selectRoute} />
                </aside>
              )}
            </div>
          )}

          {legendOpen && (
            <aside
              id="panel-legend"
              className="panel panel--legend"
              aria-labelledby="legend-title"
              onKeyDown={onPanelKeyDown(toggleLegend)}
            >
              <Legend visible={visible} onToggle={toggleLayer} onClose={toggleLegend} headingRef={legendHeadingRef} />
            </aside>
          )}

          {listOpen && (
            <aside id="panel-list" className="panel panel--list" aria-labelledby="list-title" onKeyDown={onPanelKeyDown(toggleList)}>
              <BarrierList
                barriers={barriers}
                lang={lang}
                selectedId={selection?.feature.properties.id ?? null}
                onSelect={selectBarrier}
                onClose={toggleList}
                headingRef={listHeadingRef}
              />
            </aside>
          )}
        </main>
      )}
    </div>
  );
}
