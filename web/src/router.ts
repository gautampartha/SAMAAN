// Tiny hash router: `#/` -> map, `#/capture` -> capture. No dependency needed.
import { useEffect, useState } from 'react';

export type Route = 'map' | 'capture';
export const ROUTES: readonly Route[] = ['map', 'capture'] as const;

const HASHES: Record<Route, string> = { map: '#/', capture: '#/capture' };

export function routeFromHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').replace(/\/+$/, '').toLowerCase();
  return clean === 'capture' ? 'capture' : 'map';
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
