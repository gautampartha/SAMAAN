import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  LAYER_KEYS,
  type AppMode,
  type BarrierFeature,
  type LayerData,
  type LayerKey,
  type MissionFeature,
  type Profile,
  type ReachFix,
  type ReportItem,
  type ReportPrefill,
  type ReportTarget,
  type RideSummary,
  type RouteBarrier,
  type RouteMode,
  type RouteResult,
  type WheelsJoltFeature,
  type Zone,
} from './api';
import { toLang, type Lang } from './i18n';
import { StatusStrip, TabBar } from './components/Shell';
import Legend from './components/Legend';
import BarrierList from './components/BarrierList';
import MapView, { type BarrierSelection } from './components/MapView';
import CapturePage from './components/CapturePage';
import HomeSheet, { type GoError } from './components/HomeSheet';
import RouteChoice from './components/RouteChoice';
import NavigationScreen from './components/NavigationScreen';
import ExploreScreen from './components/ExploreScreen';
import ListenScreen from './components/ListenScreen';
import WelcomeScreen, { type OnboardingChoice } from './components/WelcomeScreen';
import DemoPage from './components/DemoPage';
import { Icon } from './icons';
import ContributePage from './components/ContributePage';
import StatsPage from './components/StatsPage';
import SettingsPage from './components/SettingsPage';
import MorePage from './components/MorePage';
import ReportSheet, { type ReportMode } from './components/ReportSheet';
import ValidatePage from './components/ValidatePage';
import MissionsPage from './components/MissionsPage';
import ReachPanel from './components/ReachPanel';
import RidePage from './components/RidePage';
import type { ReachFocus, WheelsFocus } from './components/MapView';
import { MAP_ROUTES, navigate, useHashRoute, type Route } from './router';
import { formatCoords, useRoutePlanner, type PlannerPoint, type PointRole } from './routePlanner';
import { useReachGap } from './reach';
import { useSensors } from './sensors';
import { useNavigation, type NavPosition } from './navigation';
import { getMode, isOnboarded, PROFILE_MODE, setContribute, setMode, setOnboarded, useContribute, useMode } from './mode';
import { createUser, getUser, setUser, useUser } from './user';
import { addPoints } from './rewards';
import { stopSpeaking } from './speech';

type Theme = 'auto' | 'normal' | 'high-contrast';
const THEME_STORAGE_KEY = 'samaan.theme';
const MUTED_KEY = 'samaan.muted';

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

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

function systemPrefersHighContrast(): boolean {
  return window.matchMedia('(prefers-contrast: more)').matches;
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
  demo: false,
  images: false,
  wheels: false,
};

type OriginResult = PlannerPoint | 'geoDenied' | 'geoUnavailable';

export default function App() {
  const { t, i18n } = useTranslation();
  const lang: Lang = toLang(i18n.language);
  const route = useHashRoute();
  const isMapRoute = (MAP_ROUTES as readonly string[]).includes(route);

  const [zone, setZone] = useState<Zone | null>(null);
  const [zoneSettled, setZoneSettled] = useState(false);
  const [synthetic, setSynthetic] = useState(false);
  const [data, setData] = useState<LayerData>({});
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [failed, setFailed] = useState<LayerKey[]>([]);
  const [basemapError, setBasemapError] = useState(false);

  const [visible, setVisible] = useState<Record<LayerKey, boolean>>(DEFAULT_VISIBLE);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [legendOpen, setLegendOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [selection, setSelection] = useState<BarrierSelection | null>(null);

  // ---- Citizen loop: report sheet, pending markers, highlighted mission ----
  const [reportMode, setReportMode] = useState<ReportMode | null>(null);
  const reportOpenerRef = useRef<HTMLElement | null>(null);
  const [pendingReports, setPendingReports] = useState<ReportItem[]>([]);
  const [mission, setMission] = useState<MissionFeature | null>(null);

  // ---- Trip planner, modes, navigation engine ----
  const planner = useRoutePlanner();
  const pickMode = planner.state.pickMode;
  const { setPoint: setPlannerPoint, setPickMode, select: selectRoute, rerun: rerunRoutes } = planner;
  const mode = useMode();
  const contribute = useContribute();
  const sensors = useSensors();
  const nav = useNavigation(sensors);
  const navSession = nav.state.session;
  const [muted, setMuted] = useState(readMuted);
  const [follow, setFollow] = useState(true);
  const [autoStart, setAutoStart] = useState<AppMode | null>(null);
  const [goBusy, setGoBusy] = useState(false);
  const [goError, setGoError] = useState<GoError>(null);

  // ---- First run: who are you / how do you move (sets profile + mode); blind path greets in Listen ----
  const user = useUser();
  const [onboarded, setOnboardedState] = useState<boolean>(() => isOnboarded() && getUser() !== null);
  const [listenGreet, setListenGreet] = useState(false);
  const showWelcome = !onboarded || route === 'welcome';

  const legendBtnRef = useRef<HTMLButtonElement>(null);
  const listBtnRef = useRef<HTMLButtonElement>(null);
  const legendHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const homeHeadingRef = useRef<HTMLHeadingElement>(null);
  const choiceHeadingRef = useRef<HTMLHeadingElement>(null);
  const screenHeadingRef = useRef<HTMLElement>(null);
  usePanelFocus(legendOpen, legendHeadingRef, legendBtnRef);
  usePanelFocus(listOpen, listHeadingRef, listBtnRef);

  useEffect(() => {
    try {
      localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (muted) stopSpeaking();
  }, [muted]);

  // ---- Reach Gap page (uses the main map; a bottom sheet like the planner) ----
  const reach = useReachGap(route === 'reach');
  const reachHeadingRef = useRef<HTMLHeadingElement>(null);
  const [reachFocus, setReachFocus] = useState<ReachFocus | null>(null);
  useEffect(() => {
    if (route !== 'reach') return;
    const id = window.setTimeout(() => reachHeadingRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [route]);
  const closeReach = useCallback(() => navigate('more'), []);
  const showReachBarrier = useCallback((fix: ReachFix) => {
    setReachFocus({ barrierId: fix.barrier.id, lat: fix.barrier.lat, lon: fix.barrier.lon, nonce: Date.now() });
  }, []);

  // ---- Live location from launch (GPS only; the motion-sensor prompt waits for a trip) ----
  const { enableLocation } = sensors;
  useEffect(() => {
    if (onboarded) enableLocation();
  }, [onboarded, enableLocation]);
  const livePosition: NavPosition | null = useMemo(
    () => (sensors.fix ? { lat: sensors.fix.lat, lon: sensors.fix.lon, heading: null, accuracy: sensors.fix.accuracy, simulated: false, ts: sensors.fix.ts } : null),
    [sensors.fix],
  );
  // Centre on the traveller once, when the first fix lands inside the zone.
  const autoCentredRef = useRef(false);
  useEffect(() => {
    if (!sensors.fix || !zone || autoCentredRef.current) return;
    autoCentredRef.current = true;
    const { south, west, north, east } = zone.bbox;
    const inside = sensors.fix.lat >= south && sensors.fix.lat <= north && sensors.fix.lon >= west && sensors.fix.lon <= east;
    setFollow(inside);
  }, [sensors.fix, zone]);
  const locateMe = useCallback(() => {
    enableLocation();
    setFollow(true);
  }, [enableLocation]);

  // A returning Listen-mode traveller lands in Listen and is greeted, no tap needed.
  useEffect(() => {
    if (onboarded && getMode() === 'listen' && currentRouteIsHome()) {
      setListenGreet(true);
      navigate('listen');
    }
    function currentRouteIsHome() {
      return location.hash === '' || location.hash === '#/' || location.hash === '#/home';
    }
    // On mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (route !== 'listen' && route !== 'welcome') setListenGreet(false);
  }, [route]);

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

  // ---- Live update plumbing: reload footpaths + barriers (+ coverage / wheels) after the server changed them. ----
  const [refreshing, setRefreshing] = useState(false);
  const coverageVisibleRef = useRef(visible.coverage);
  coverageVisibleRef.current = visible.coverage;
  const refreshLayers = useCallback(async () => {
    setRefreshing(true);
    const withCoverage = coverageVisibleRef.current;
    const [fp, ba, cov, wh] = await Promise.allSettled([
      api.footpaths(),
      api.barriers(),
      withCoverage ? api.coverage() : Promise.resolve(undefined),
      api.wheels(),
    ]);
    setData((cur) => {
      const next: LayerData = { ...cur };
      if (fp.status === 'fulfilled') next.footpaths = fp.value;
      if (ba.status === 'fulfilled') next.barriers = ba.value;
      if (cov.status === 'fulfilled' && cov.value) next.coverage = cov.value;
      if (wh.status === 'fulfilled' && wh.value) next.wheels = wh.value;
      return next;
    });
    if (ba.status === 'fulfilled') {
      const known = new Set(ba.value.features.map((f) => f.properties.id));
      setPendingReports((list) => list.filter((r) => r.barrier_id === null || !known.has(r.barrier_id)));
    }
    setRefreshing(false);
  }, []);

  /** A vote (or report) resolved server-side: reload the layers and re-run the last comparison. */
  const onResolved = useCallback(() => {
    void refreshLayers();
    rerunRoutes();
  }, [refreshLayers, rerunRoutes]);

  // Coming back to the map from a page: others may have changed the map meanwhile.
  const prevRouteRef = useRef<Route | null>(null);
  useEffect(() => {
    const prev = prevRouteRef.current;
    prevRouteRef.current = route;
    const wasMap = prev !== null && (MAP_ROUTES as readonly string[]).includes(prev);
    if (isMapRoute && prev !== null && !wasMap) void refreshLayers();
    if (!isMapRoute) setPickMode(null);
    if (route !== 'map') {
      setLegendOpen((o) => (route === 'reach' ? o : false));
      setListOpen(false);
    }
    // Focus the sheet heading when arriving on Home / the route choice from another page.
    if (prev !== null && prev !== route) {
      const id = window.setTimeout(() => {
        if (route === 'home') homeHeadingRef.current?.focus();
        else if (route === 'navigate' && !navSession) (planner.state.result ? choiceHeadingRef : homeHeadingRef).current?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
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

  // Legend and barrier list are bottom sheets: only one open at a time.
  const toggleLegend = useCallback(() => {
    setLegendOpen((open) => {
      if (!open) setListOpen(false);
      return !open;
    });
  }, []);
  const toggleList = useCallback(() => {
    setListOpen((open) => {
      if (!open) setLegendOpen(false);
      return !open;
    });
  }, []);

  // A map pick sets the planner point and ends pick mode.
  const onPick = useCallback(
    (role: PointRole, lat: number, lon: number) => {
      setPlannerPoint(role, { lat, lon, label: formatCoords(lat, lon) });
    },
    [setPlannerPoint],
  );

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
    setListOpen(false);
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
  const onReportSubmitted = useCallback(
    (rep: ReportItem) => {
      addPoints('report');
      if (rep.kind === 'barrier' && rep.status === 'pending') setPendingReports((list) => [...list, rep]);
      if (rep.status !== 'pending') onResolved();
    },
    [onResolved],
  );

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
      await refreshLayers();
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

  // ---- Mode <-> profile coupling ----
  const profiles = planner.state.profiles;
  const chooseMode = useCallback(
    (m: AppMode) => {
      setMode(m);
      const current = profiles.find((p) => p.id === planner.state.profile);
      if (!current || current.mode !== m) {
        const match = profiles.find((p) => p.mode === m);
        if (match) planner.setProfile(match.id);
      }
    },
    [profiles, planner],
  );
  const chooseProfile = useCallback(
    (p: Profile) => {
      planner.setProfile(p);
      const info = profiles.find((x) => x.id === p);
      if (info && info.mode !== 'baseline') setMode(info.mode);
    },
    [profiles, planner],
  );

  const finishOnboarding = useCallback(
    async (choice: OnboardingChoice) => {
      const m = PROFILE_MODE[choice.profile];
      planner.setProfile(choice.profile);
      setMode(m);
      try {
        await createUser(choice.name, choice.profile, lang, false);
      } catch (err) {
        // Offline / API down: keep going with a local identity; reports will ask again when the API is back.
        console.warn('[onboarding] user not created on the server', err);
        setUser({ id: `local-${Date.now()}`, display_name: choice.name, trust_score: 0.3, profile: choice.profile });
      }
      setOnboarded(true);
      setOnboardedState(true);
      setListenGreet(m === 'listen');
      navigate(m === 'listen' ? 'listen' : 'home');
    },
    [planner, lang],
  );

  // Points for a completed trip (once per session).
  const tripCreditedRef = useRef(false);
  useEffect(() => {
    if (!navSession) {
      tripCreditedRef.current = false;
      return;
    }
    if (nav.state.arrived && !tripCreditedRef.current) {
      tripCreditedRef.current = true;
      addPoints('trip');
    }
  }, [navSession, nav.state.arrived]);

  // ---- Trip flow: Go -> routes -> (Move) choice / (Explore, Listen) start at once ----
  const startNavigation = useCallback(
    (r: RouteResult, m: RouteMode) => {
      nav.start(r, m, contribute);
      selectRoute(m);
      setFollow(true);
    },
    [nav, contribute, selectRoute],
  );
  const endNavigation = useCallback(() => {
    nav.stop();
    stopSpeaking();
    if (route === 'explore') navigate('home');
  }, [nav, route]);

  const resolveOrigin = useCallback(
    (): Promise<OriginResult> =>
      new Promise((resolve) => {
        if (planner.state.origin) {
          resolve(planner.state.origin);
          return;
        }
        if (!('geolocation' in navigator)) {
          resolve('geoUnavailable');
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: t('route.myLocation') }),
          (err) => resolve(err.code === 1 ? 'geoDenied' : 'geoUnavailable'),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
        );
      }),
    [planner.state.origin, t],
  );

  const go = useCallback(async () => {
    const dest = planner.state.destination;
    if (!dest) {
      setGoError('noDestination');
      return;
    }
    setGoBusy(true);
    setGoError(null);
    const from = await resolveOrigin();
    setGoBusy(false);
    if (typeof from === 'string') {
      setGoError(from);
      return;
    }
    if (mode !== 'move') setAutoStart(mode);
    planner.compareBetween(from, dest);
    navigate(mode === 'move' ? 'navigate' : mode);
  }, [planner, resolveOrigin, mode]);

  const runDemo = useCallback(
    (forMode: AppMode = mode) => {
      setGoError(null);
      if (forMode !== 'move') setAutoStart(forMode);
      planner.runDemo();
      navigate(forMode === 'move' ? 'navigate' : forMode);
    },
    [planner, mode],
  );

  /** Listen mode: route to a spoken destination; navigation starts when the routes arrive. */
  const routeForListen = useCallback(
    async (to: PlannerPoint): Promise<'ok' | 'geoDenied' | 'geoUnavailable'> => {
      const from = await resolveOrigin();
      if (typeof from === 'string') return from;
      setAutoStart('listen');
      planner.compareBetween(from, to);
      return 'ok';
    },
    [planner, resolveOrigin],
  );

  const { result, loading: routesLoading, error: routesError } = planner.state;
  useEffect(() => {
    if (!autoStart || routesLoading) return;
    if (routesError) {
      setAutoStart(null);
      return;
    }
    if (!result) return;
    const m: RouteMode | null = result.routes.samaan ? 'samaan' : result.routes.standard ? 'standard' : null;
    if (m && result.routes[m]) startNavigation(result.routes[m] as RouteResult, m);
    setAutoStart(null);
  }, [autoStart, result, routesLoading, routesError, startNavigation]);

  // When a comparison arrives, hide the static demo layer (its dashed line would be confused with a route).
  useEffect(() => {
    if (result) setVisible((v) => (v.demo ? { ...v, demo: false } : v));
  }, [result]);

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
    <p className={`statusline statusline--${status}${status === 'ok' ? ' sr-only' : ''}`} role="status" aria-live="polite">
      {statusText}
      {basemapError && <span className="statusline__extra"> {t('load.basemap')}</span>}
    </p>
  );

  const missionName = mission ? (lang === 'hi' ? mission.properties.name_hi || mission.properties.name_en : mission.properties.name_en) : '';

  // ---- Layout decisions ----
  const navScreen = route === 'navigate' || route === 'explore' || route === 'listen';
  const navActive = Boolean(navSession) && navScreen;
  const hideTabs = navActive;
  const hideStrip = navActive && route === 'explore';
  const showHome = route === 'home' || (route === 'navigate' && !navSession && !result && !routesLoading) || (route === 'explore' && !navSession);
  const showChoice = route === 'navigate' && !navSession && (result !== null || routesLoading);
  const sheetFraction =
    navActive ? 0.3 : route === 'home' || showHome ? 0.56 : showChoice ? 0.54 : route === 'reach' ? 0.6 : route === 'listen' ? 0.7 : legendOpen || listOpen ? 0.5 : 0.06;
  const hidingSheet = Boolean(pickMode);

  if (showWelcome) {
    return (
      <div className="app app--welcome">
        <main id="main" className="main main--welcome" tabIndex={-1}>
          <WelcomeScreen lang={lang} onLang={changeLang} onDone={finishOnboarding} initialProfile={user?.profile ?? null} initialName={user?.display_name ?? ''} />
        </main>
      </div>
    );
  }

  return (
    <div className={`app${navActive ? ' app--nav' : ''}`}>
      <a className="skip-link" href="#main">
        {t('skip.toContent')}
      </a>
      <div className={`phone${hideStrip ? ' phone--nostrip' : ''}${hideTabs ? ' phone--notabs' : ''}`}>
        {!hideStrip && <StatusStrip zone={zone} lang={lang} synthetic={synthetic} status={statusNode} />}

        {isMapRoute ? (
          <main id="main" className="main" tabIndex={-1}>
            <MapView
              zone={zone}
              zoneSettled={zoneSettled}
              data={data}
              visible={visible}
              lang={lang}
              selection={selection}
              onBasemapError={() => setBasemapError(true)}
              routes={result}
              selectedRoute={navSession ? navSession.mode : planner.state.selected}
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
              userPosition={navSession ? nav.state.position : livePosition}
              follow={follow}
              onUserPan={() => setFollow(false)}
              sheetFraction={sheetFraction}
            />

            {status === 'error' && !navActive && (
              <div className="banner banner--error" role="alert">
                {t('load.error')}
              </div>
            )}

            {pickMode && (
              <div className="banner banner--pick" role="status" aria-live="polite">
                {t('route.pickHint', { field: t(`route.${pickMode}`).toLocaleLowerCase() })}
                <button type="button" className="btn btn--small" onClick={() => setPickMode(null)}>
                  {t('panels.close')}
                </button>
              </div>
            )}

            {route === 'map' && mission && !pickMode && (
              <div className="banner banner--pick banner--mission" role="status" aria-live="polite" lang={lang}>
                <span>{t('missions.onMap', { rank: mission.properties.rank, name: missionName })}</span>
                <button type="button" className="btn btn--small" onClick={() => setMission(null)}>
                  {t('missions.clearMap')}
                </button>
              </div>
            )}

            {showHome && !hidingSheet && (
              <HomeSheet
                planner={planner}
                lang={lang}
                mode={mode}
                onMode={chooseMode}
                onGo={() => void go()}
                onDemo={() => runDemo()}
                onReport={reportBarrier}
                fix={sensors.fix}
                geoError={sensors.geoError}
                goBusy={goBusy}
                goError={goError}
                headingRef={homeHeadingRef}
                compact={route !== 'home'}
              />
            )}

            {showChoice && !hidingSheet && result && (
              <RouteChoice
                result={result}
                selected={planner.state.selected}
                lang={lang}
                loading={routesLoading}
                onSelect={selectRoute}
                onStart={(m) => {
                  const r = result.routes[m];
                  if (r) startNavigation(r, m);
                }}
                onEdit={() => {
                  planner.clear();
                  navigate('home');
                }}
                onReportFixed={reportFixedFromRoute}
                headingRef={choiceHeadingRef}
              />
            )}
            {showChoice && !result && routesLoading && (
              <section className="sheet-choice" aria-busy="true">
                <div className="grabber" aria-hidden="true" />
                <p className="place__status" role="status">
                  {t('route.loading')}
                </p>
              </section>
            )}

            {route === 'navigate' && navSession && (
              <NavigationScreen
                nav={nav}
                sensors={sensors}
                lang={lang}
                muted={muted}
                onToggleMute={() => setMuted((m) => !m)}
                onReport={reportBarrier}
                onEnd={endNavigation}
                follow={follow}
                onRecenter={() => setFollow(true)}
                headingRef={screenHeadingRef}
              />
            )}

            {route === 'explore' && navSession && (
              <ExploreScreen
                nav={nav}
                sensors={sensors}
                lang={lang}
                muted={muted}
                onToggleMute={() => setMuted((m) => !m)}
                onEnd={endNavigation}
                onReport={reportBarrier}
                headingRef={screenHeadingRef}
                destination={result?.label_en ? (lang === 'hi' ? result.label_hi || result.label_en : result.label_en) : planner.state.destination?.label}
              />
            )}

            {route === 'listen' && (
              <ListenScreen
                nav={nav}
                planner={planner}
                sensors={sensors}
                lang={lang}
                onRoute={routeForListen}
                onDemo={() => runDemo('listen')}
                onEnd={endNavigation}
                onReport={reportBarrier}
                onHome={() => navigate('home')}
                onReported={onReportSubmitted}
                autoGreet={listenGreet}
                headingRef={screenHeadingRef}
              />
            )}

            {route === 'reach' && (
              <aside id="panel-reach" className="panel panel--reach" aria-labelledby="reach-title" onKeyDown={onPanelKeyDown(closeReach)}>
                <ReachPanel reach={reach} lang={lang} onClose={closeReach} headingRef={reachHeadingRef} onShowBarrier={showReachBarrier} />
              </aside>
            )}

            {(route === 'map' || route === 'reach') && (
              <div className="maptools" role="group" aria-label={t('map.toolsLabel')}>
                <button ref={legendBtnRef} type="button" className="pill" aria-expanded={legendOpen} aria-controls="panel-legend" onClick={toggleLegend}>
                  {t('panels.legend')}
                </button>
                {route === 'map' && (
                  <button ref={listBtnRef} type="button" className="pill" aria-expanded={listOpen} aria-controls="panel-list" onClick={toggleList}>
                    {t('panels.barriers')}
                  </button>
                )}
              </div>
            )}

            {!navActive && !pickMode && route !== 'listen' && route !== 'reach' && (
              <button type="button" className={`locatebtn${follow && sensors.fix ? ' locatebtn--on' : ''}`} onClick={locateMe} aria-label={t('map.locate')} title={t('map.locate')} aria-pressed={follow && Boolean(sensors.fix)}>
                <Icon name="locate" size={24} />
              </button>
            )}
            {(route === 'home' || route === 'navigate') && !navActive && !pickMode && (
              <button type="button" className="fab fab--top" onClick={reportBarrier}>
                <Icon name="flag" size={20} />
                <span className="fab__text">{t('report.short')}</span>
              </button>
            )}

            {route === 'map' && !legendOpen && !listOpen && !pickMode && (
              <button type="button" className="fab" onClick={reportBarrier}>
                <span className="fab__glyph" aria-hidden="true">
                  +
                </span>
                <span className="fab__text">{t('report.fab')}</span>
              </button>
            )}

            {legendOpen && (route === 'map' || route === 'reach') && (
              <aside id="panel-legend" className="panel panel--legend" aria-labelledby="legend-title" onKeyDown={onPanelKeyDown(toggleLegend)}>
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
          </main>
        ) : (
          <main id="main" className="main main--page" tabIndex={-1}>
            {route === 'capture' && <CapturePage />}
            {route === 'validate' && <ValidatePage zone={zone} lang={lang} onResolved={onResolved} />}
            {route === 'missions' && <MissionsPage lang={lang} onShowOnMap={showMission} onShowJolt={showJolt} />}
            {route === 'ride' && <RidePage lang={lang} onShowOnMap={(s) => void showRideOnMap(s)} />}
            {route === 'contribute' && <ContributePage contribute={contribute} onToggle={setContribute} onReport={reportBarrier} />}
            {route === 'stats' && <StatsPage data={data} lang={lang} loading={refreshing} onRefresh={() => void refreshLayers()} />}
            {route === 'settings' && (
              <SettingsPage planner={planner} lang={lang} onLangChange={changeLang} highContrast={highContrast} onToggleContrast={toggleContrast} onProfile={chooseProfile} />
            )}
            {route === 'more' && <MorePage />}
            {route === 'demo' && (
              <DemoPage
                lang={lang}
                onRunDemo={(m) => {
                  chooseMode(m);
                  runDemo(m);
                }}
                onChanged={onResolved}
              />
            )}
          </main>
        )}

        {!hideTabs && <TabBar route={route} />}
      </div>

      {reportMode && <ReportSheet mode={reportMode} lang={lang} onClose={closeReport} onSubmitted={onReportSubmitted} />}
    </div>
  );
}
