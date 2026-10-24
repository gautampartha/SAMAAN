import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  LAYER_KEYS,
  type BarrierFeature,
  type LayerData,
  type LayerKey,
  type MissionFeature,
  type ReachFix,
  type ReportItem,
  type ReportPrefill,
  type ReportTarget,
  type RideSummary,
  type RouteBarrier,
  type WheelsJoltFeature,
  type Zone,
} from './api';
import { toLang, type Lang } from './i18n';
import Header from './components/Header';
import Legend from './components/Legend';
import BarrierList from './components/BarrierList';
import MapView, { type BarrierSelection } from './components/MapView';
import CapturePage from './components/CapturePage';
import RoutePlanner from './components/RoutePlanner';
import RouteCompare from './components/RouteCompare';
import ReportSheet, { type ReportMode } from './components/ReportSheet';
import ValidatePage from './components/ValidatePage';
import MissionsPage from './components/MissionsPage';
import ReachPanel from './components/ReachPanel';
import RidePage from './components/RidePage';
import type { ReachFocus, WheelsFocus } from './components/MapView';
import { navigate, useHashRoute, type Route } from './router';
import { formatCoords, useRoutePlanner, type PointRole } from './routePlanner';
import { useReachGap } from './reach';

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
  wheels: false,
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

  // ---- Citizen loop: report sheet, pending markers, highlighted mission ----
  const [reportMode, setReportMode] = useState<ReportMode | null>(null);
  const reportOpenerRef = useRef<HTMLElement | null>(null);
  const [pendingReports, setPendingReports] = useState<ReportItem[]>([]);
  const [mission, setMission] = useState<MissionFeature | null>(null);

  // ---- Route planner ----
  const planner = useRoutePlanner();
  const plannerOpen = planner.state.open;
  const pickMode = planner.state.pickMode;
  // Stable actions (useCallback / setState inside the hook) for dependency lists.
  const { setOpen: setPlannerOpen, setPoint: setPlannerPoint, setPickMode, select: selectRoute, rerun: rerunRoutes } = planner;
  const plannerBtnRef = useRef<HTMLButtonElement>(null);
  const legendBtnRef = useRef<HTMLButtonElement>(null);
  const listBtnRef = useRef<HTMLButtonElement>(null);
  const plannerHeadingRef = useRef<HTMLHeadingElement>(null);
  const legendHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  usePanelFocus(plannerOpen, plannerHeadingRef, plannerBtnRef);
  usePanelFocus(legendOpen, legendHeadingRef, legendBtnRef);
  usePanelFocus(listOpen, listHeadingRef, listBtnRef);

  // ---- Reach Gap page (uses the main map; a side panel / bottom sheet like the planner) ----
  const reach = useReachGap(route === 'reach');
  const reachHeadingRef = useRef<HTMLHeadingElement>(null);
  const reachLinkRef = useRef<HTMLAnchorElement>(null);
  const [reachFocus, setReachFocus] = useState<ReachFocus | null>(null);
  // Opening the page moves focus to its heading; Close / Escape go back to the map and return focus to the nav link.
  useEffect(() => {
    if (route !== 'reach') return;
    const id = window.setTimeout(() => reachHeadingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [route]);
  const closeReach = useCallback(() => {
    navigate('map');
    window.setTimeout(() => reachLinkRef.current?.focus(), 0);
  }, []);
  const showReachBarrier = useCallback((fix: ReachFix) => {
    setReachFocus({ barrierId: fix.barrier.id, lat: fix.barrier.lat, lon: fix.barrier.lon, nonce: Date.now() });
  }, []);

  // ---- Data loading: everything in parallel; partial failures keep the rest. ----
  useEffect(() => {
    const ac = new AbortController();
    const s = ac.signal;
    (async () => {
      const [h, z, fp, ba, cov, an, de, im, wh] = await Promise.allSettled([
        api.health(s),
        api.zone(s),
        api.footpaths(s),
        api.barriers(s),
        api.coverage(s),
        api.anchors(s),
        api.demo(s),
        api.images(s),
        api.wheels(s),
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
      pick('wheels', wh);

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

  // ---- Live update plumbing: reload footpaths + barriers (+ coverage / wheels when shown) after the server changed them. ----
  const coverageVisibleRef = useRef(visible.coverage);
  coverageVisibleRef.current = visible.coverage;
  const wheelsVisibleRef = useRef(visible.wheels);
  wheelsVisibleRef.current = visible.wheels;
  const refreshLayers = useCallback(async () => {
    const withCoverage = coverageVisibleRef.current;
    const withWheels = wheelsVisibleRef.current;
    const [fp, ba, cov, wh] = await Promise.allSettled([
      api.footpaths(),
      api.barriers(),
      withCoverage ? api.coverage() : Promise.resolve(undefined),
      withWheels ? api.wheels() : Promise.resolve(undefined),
    ]);
    setData((cur) => {
      const next: LayerData = { ...cur };
      if (fp.status === 'fulfilled') next.footpaths = fp.value;
      if (ba.status === 'fulfilled') next.barriers = ba.value;
      if (cov.status === 'fulfilled' && cov.value) next.coverage = cov.value;
      if (wh.status === 'fulfilled' && wh.value) next.wheels = wh.value;
      return next;
    });
    // Reports that became barriers (or were rejected) are no longer pending.
    if (ba.status === 'fulfilled') {
      const known = new Set(ba.value.features.map((f) => f.properties.id));
      setPendingReports((list) => list.filter((r) => r.barrier_id === null || !known.has(r.barrier_id)));
    }
  }, []);

  /** A vote (or report) resolved server-side: reload the layers and re-run the last comparison. */
  const onResolved = useCallback(() => {
    void refreshLayers();
    rerunRoutes();
  }, [refreshLayers, rerunRoutes]);

  // Coming back to the map from Validate/Missions/Capture: others may have changed the map meanwhile.
  const prevRouteRef = useRef<Route | null>(null);
  useEffect(() => {
    const prev = prevRouteRef.current;
    prevRouteRef.current = route;
    if (route === 'map' && prev !== null && prev !== 'map') void refreshLayers();
    if (route !== 'map' && reportMode) setReportMode(null);
    if (route !== 'map') setPickMode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, refreshLayers]);

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

  // ---- Report sheet ----
  const openReport = useCallback((mode: ReportMode) => {
    reportOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReportMode(mode);
  }, []);
  const closeReport = useCallback(() => {
    setReportMode(null);
    const opener = reportOpenerRef.current;
    reportOpenerRef.current = null;
    window.setTimeout(() => {
      if (opener && opener.isConnected) opener.focus();
      else document.getElementById('main')?.focus();
    }, 0);
  }, []);
  const reportBarrier = useCallback(() => openReport({ kind: 'barrier' }), [openReport]);
  const reportFixed = useCallback((target: ReportTarget) => openReport({ kind: 'fixed', target }), [openReport]);
  const reportFixedFromRoute = useCallback(
    (b: RouteBarrier) => reportFixed({ id: b.id, class_id: b.class, name_en: b.name_en, name_hi: b.name_hi, severity: b.severity }),
    [reportFixed],
  );
  const onReportSubmitted = useCallback((rep: ReportItem) => {
    if (rep.kind === 'barrier' && rep.status === 'pending') setPendingReports((list) => [...list, rep]);
    // A report may resolve immediately (e.g. a trusted reporter): reload so the map/routes catch up.
    if (rep.status !== 'pending') onResolved();
  }, [onResolved]);

  const showMission = useCallback((m: MissionFeature) => {
    setMission(m);
    navigate('map');
  }, []);

  // ---- P9 wheels: show a ride's verified edges / a jolt on the map; photograph a jolt ----
  const [wheelsFocus, setWheelsFocus] = useState<WheelsFocus | null>(null);
  const showRideOnMap = useCallback(
    async (s: RideSummary) => {
      setVisible((v) => (v.wheels ? v : { ...v, wheels: true }));
      navigate('map');
      // Footpaths/barriers changed server-side (verified states, suspected barriers); then the wheels layer itself.
      await refreshLayers();
      try {
        const w = await api.wheels();
        setData((cur) => ({ ...cur, wheels: w }));
      } catch (err) {
        console.warn('[wheels]', err);
      }
      setWheelsFocus({ kind: 'edges', edgeIds: s.verified_edge_ids, nonce: Date.now() });
    },
    [refreshLayers],
  );
  const showJolt = useCallback((feature: WheelsJoltFeature) => {
    setVisible((v) => (v.wheels ? v : { ...v, wheels: true }));
    setWheelsFocus({ kind: 'jolt', feature, nonce: Date.now() });
    navigate('map');
  }, []);
  const photographJolt = useCallback((prefill: ReportPrefill) => openReport({ kind: 'barrier', prefill }), [openReport]);

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

  const missionName = mission ? (lang === 'hi' ? mission.properties.name_hi || mission.properties.name_en : mission.properties.name_en) : '';

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
        reachLinkRef={reachLinkRef}
        synthetic={synthetic}
        status={route === 'map' ? statusNode : null}
        route={route}
      />

      {route === 'capture' ? (
        <main id="main" className="main main--page" tabIndex={-1}>
          <CapturePage />
        </main>
      ) : route === 'validate' ? (
        <main id="main" className="main main--page" tabIndex={-1}>
          <ValidatePage zone={zone} lang={lang} onResolved={onResolved} />
        </main>
      ) : route === 'missions' ? (
        <main id="main" className="main main--page" tabIndex={-1}>
          <MissionsPage lang={lang} onShowOnMap={showMission} onShowJolt={showJolt} />
        </main>
      ) : route === 'ride' ? (
        <main id="main" className="main main--page" tabIndex={-1}>
          <RidePage lang={lang} onShowOnMap={(s) => void showRideOnMap(s)} />
        </main>
      ) : (
        <main id="main" className={`main${plannerOpen && route === 'map' ? ' main--planner' : ''}${route === 'reach' ? ' main--reach' : ''}`} tabIndex={-1}>
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
            pendingReports={pendingReports}
            mission={mission}
            onReportFixed={reportFixed}
            reach={route === 'reach' ? reach.state.result : null}
            reachFixed={reach.state.fixed}
            reachFocus={route === 'reach' ? reachFocus : null}
            onPhotographJolt={photographJolt}
            wheelsFocus={wheelsFocus}
          />

          {route === 'reach' && (
            <aside id="panel-reach" className="panel panel--reach" aria-labelledby="reach-title" onKeyDown={onPanelKeyDown(closeReach)}>
              <ReachPanel reach={reach} lang={lang} onClose={closeReach} headingRef={reachHeadingRef} onShowBarrier={showReachBarrier} />
            </aside>
          )}

          {pickMode && !plannerOpen && (
            <div className="banner banner--pick" role="status" aria-live="polite">
              {t('route.pickHint', { field: t(`route.${pickMode}`).toLocaleLowerCase() })}
              <button type="button" className="btn" onClick={() => setPickMode(null)}>
                {t('panels.close')}
              </button>
            </div>
          )}

          {mission && !pickMode && (
            <div className="banner banner--pick banner--mission" role="status" aria-live="polite" lang={lang}>
              <span>{t('missions.onMap', { rank: mission.properties.rank, name: missionName })}</span>
              <button type="button" className="btn" onClick={() => setMission(null)}>
                {t('missions.clearMap')}
              </button>
            </div>
          )}

          {status === 'error' && (
            <div className="banner banner--error" role="alert">
              {t('load.error')}
            </div>
          )}

          {route === 'map' && !plannerOpen && !pickMode && (
            <button type="button" className="fab" onClick={reportBarrier}>
              <span className="fab__glyph" aria-hidden="true">
                📣
              </span>
              <span className="fab__text">{t('report.fab')}</span>
            </button>
          )}

          {route === 'map' && plannerOpen && (
            <div className="route-dock" onKeyDown={onPanelKeyDown(togglePlanner)}>
              <aside id="panel-route" className="panel panel--route" aria-labelledby="route-title">
                <RoutePlanner planner={planner} lang={lang} onClose={togglePlanner} headingRef={plannerHeadingRef} onReport={reportBarrier} />
              </aside>
              {result && (
                <aside className="panel panel--compare" aria-labelledby="compare-title">
                  <RouteCompare
                    result={result}
                    selected={planner.state.selected}
                    lang={lang}
                    onSelect={selectRoute}
                    onReportFixed={reportFixedFromRoute}
                  />
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

          {route === 'map' && listOpen && (
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

          {reportMode && <ReportSheet mode={reportMode} lang={lang} onClose={closeReport} onSubmitted={onReportSubmitted} />}
        </main>
      )}
    </div>
  );
}
