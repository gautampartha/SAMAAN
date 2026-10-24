# SAMAAN web (P0 scaffold)

Vite + React 18 + TypeScript single-page PWA that renders the SAMAAN API's
GeoJSON layers on a MapLibre GL JS map, in English and Hindi, with
accessibility built in from the start.

## Run

```bash
cd web
cp .env.example .env     # optional; defaults to http://127.0.0.1:8000
npm install
npm run dev              # http://127.0.0.1:5173
```

Other scripts: `npm run build` (type-check + production bundle in `dist/`),
`npm run preview` (serve the built bundle), `npm run typecheck`.

The Python API must be running separately; the frontend never ships fake
features. If the API is unreachable it shows a translated error and an
empty map.

## Environment

| Variable       | Default                  | Purpose                                |
| -------------- | ------------------------ | -------------------------------------- |
| `VITE_API_URL` | `http://127.0.0.1:8000`  | Base URL of the SAMAAN API (no slash)  |

## Where things live

- `src/api.ts` - TypeScript types for the API contract and typed fetch helpers.
- `src/i18n/en.json`, `src/i18n/hi.json` - every UI string. `src/i18n/index.ts`
  initialises i18next, persists the chosen language in `localStorage`
  (`samaan.lang`) and keeps `<html lang>` in sync.
- `src/components/MapView.tsx` - MapLibre map, sources/layers, popups.
- `src/components/BarrierList.tsx` - keyboard/screen-reader list of barriers.
- `src/components/Legend.tsx` - layer toggles and pattern legend.
- `src/components/Header.tsx` - app name, zone, language/contrast/panel controls.
- `src/styles.css` - mobile-first styles, light/dark/high-contrast tokens.
- `public/manifest.webmanifest`, `public/icon.svg` - PWA manifest (no service
  worker yet).

Barrier names in popups and the list use `name_en` / `name_hi` from the API;
the i18n files also carry the eight barrier class names for labels.

## Accessibility checklist

- [x] Skip-to-content link (first focusable element).
- [x] Every control has an accessible name; language and contrast toggles use
      `aria-pressed`, panel toggles use `aria-expanded` + `aria-controls`.
- [x] Touch targets at least 48 x 48 px (buttons, checkboxes rows, map zoom
      buttons, popup close button, list items).
- [x] Visible focus rings (`:focus-visible`, 3 px) everywhere, including the
      map canvas and popup close button.
- [x] High-contrast toggle persisted in `localStorage` (`samaan.theme`);
      `prefers-contrast: more` and `prefers-color-scheme: dark` are respected
      unless the user chose otherwise.
- [x] `<html lang>` follows the chosen language; popups set `lang` too.
- [x] `role="status"` / `aria-live="polite"` line for load progress; errors use
      `role="alert"`.
- [x] No information by colour alone: footpath states differ by width and dash
      pattern, barrier severity by circle size and a numeric label, the legend
      describes each pattern in words, pressed buttons are also underlined.
- [x] Barrier list is the screen-reader alternative to the map; selecting an
      item flies the map there and opens the popup.
- [x] Reduced-motion preference disables the fly-to animation.
- [x] Mobile-first layout; toolbar sits at the bottom on narrow screens for
      one-handed use; panels become bottom sheets; no horizontal scroll at 375 px.

Not yet done (later phases): service worker/offline, keyboard navigation of
map features themselves (use the list), route planning UI.
