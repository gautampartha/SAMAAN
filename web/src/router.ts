// Tiny hash router, no dependency. `#/` (and `#/home`) -> Home; the other pages are listed below.
// Tabs: Home, Navigate (also Explore / Listen), Contribute, More (Demo, Map, Validate, Missions, Reach Gap,
// Ride, Capture, Statistics, Settings). `welcome` is the first-run onboarding (no tabs).
import { useEffect, useState } from 'react';

export type Route =
  | 'welcome'
  | 'home'
  | 'navigate'
  | 'explore'
  | 'listen'
  | 'contribute'
  | 'more'
  | 'map'
  | 'capture'
  | 'validate'
  | 'missions'
  | 'reach'
  | 'ride'
  | 'stats'
  | 'settings'
  | 'demo';

export const ROUTES: readonly Route[] = [
  'welcome',
  'home',
  'navigate',
  'explore',
  'listen',
  'contribute',
  'more',
  'map',
  'capture',
  'validate',
  'missions',
  'reach',
  'ride',
  'stats',
  'settings',
  'demo',
] as const;

export type Tab = 'home' | 'navigate' | 'contribute' | 'more';
export const TABS: readonly Tab[] = ['home', 'navigate', 'contribute', 'more'] as const;

/** Pages reachable from the More tab, in display order. */
export const MORE_ROUTES: readonly Route[] = ['demo', 'map', 'validate', 'missions', 'reach', 'ride', 'capture', 'stats', 'settings'] as const;

/** More page sections (display order). */
export const MORE_GROUPS: readonly { id: string; routes: readonly Route[] }[] = [
  { id: 'demo', routes: ['demo', 'map', 'stats'] },
  { id: 'community', routes: ['validate', 'missions', 'capture', 'ride'] },
  { id: 'planning', routes: ['reach'] },
  { id: 'app', routes: ['settings'] },
] as const;

/** Routes that keep the map mounted behind their sheet / overlay. */
export const MAP_ROUTES: readonly Route[] = ['home', 'navigate', 'explore', 'listen', 'map', 'reach'] as const;

export function tabFor(route: Route): Tab {
  if (route === 'home') return 'home';
  if (route === 'navigate' || route === 'explore' || route === 'listen') return 'navigate';
  if (route === 'contribute') return 'contribute';
  return 'more';
}

export function routeFromHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').replace(/\/+$/, '').toLowerCase();
  if (clean === '') return 'home';
  return (ROUTES as readonly string[]).includes(clean) ? (clean as Route) : 'home';
}

export function hrefFor(route: Route): string {
  return route === 'home' ? '#/home' : `#/${route}`;
}

export function currentRoute(): Route {
  return routeFromHash(typeof location === 'undefined' ? '' : location.hash);
}

export function navigate(route: Route): void {
  const href = hrefFor(route);
  if (location.hash !== href) location.hash = href;
}

/** Current route, updated on every `hashchange`. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
