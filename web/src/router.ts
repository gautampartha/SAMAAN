// Tiny hash router: `#/` -> map, `#/capture`, `#/validate`, `#/missions`. No dependency needed.
import { useEffect, useState } from 'react';

export type Route = 'map' | 'capture' | 'validate' | 'missions';
export const ROUTES: readonly Route[] = ['map', 'capture', 'validate', 'missions'] as const;

const HASHES: Record<Route, string> = { map: '#/', capture: '#/capture', validate: '#/validate', missions: '#/missions' };

export function routeFromHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').replace(/\/+$/, '').toLowerCase();
  return (ROUTES as readonly string[]).includes(clean) && clean !== 'map' ? (clean as Route) : 'map';
}

export function hrefFor(route: Route): string {
  return HASHES[route];
}

export function currentRoute(): Route {
  return routeFromHash(typeof location === 'undefined' ? '' : location.hash);
}

export function navigate(route: Route): void {
  if (location.hash !== HASHES[route]) location.hash = HASHES[route];
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
