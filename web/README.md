# SAMAAN web (P0 scaffold + P2 capture)

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

| Variable       | Default                  | Purpose                                                        |
| -------------- | ------------------------ | -------------------------------------------------------------- |
| `VITE_API_URL` | `http://127.0.0.1:8000`  | Base URL of the SAMAAN API (no slash); used for layers, photo uploads (`POST /images`), photo display (`GET /images/{id}/photo`) and `POST /coverage/recompute` |

## Pages

The app is a single page with a hash router (`src/router.ts`, no library):

- `#/` (default) - the map.
- `#/capture` - the photo-walk capture page.

The header carries a Map / Capture navigation with `aria-current="page"`.

## Capture page (`#/capture`)

For a phone held upright while walking along a footpath, photographing both
sides of every street. Everything is in the bottom bar for one-handed use.

1. **Enable sensors** - one tap that asks for motion-sensor permission (iOS
   requires `DeviceOrientationEvent.requestPermission()` from a user gesture)
   and starts `geolocation.watchPosition` with high accuracy.
2. Live readouts: lat/lon (5 decimals), GPS accuracy with a quality word
   (good <= 8 m, ok <= 20 m, poor), compass heading with a rotating glyph and
   cardinal direction, pitch, and the compass source (absolute / relative /
   none). A hidden `aria-live` region summarises the same values at most once
   every 2 s so screen readers are not flooded.
3. **Take photo** (64 px tall) grabs the current preview frame onto a canvas
   and exports JPEG (quality 0.85). **Auto capture** takes a photo every N
   metres walked (haversine on the GPS track) when accuracy is <= 25 m.
4. Settings (persisted in `localStorage` under `samaan.capture.*`): horizontal
   field of view (30-120, default 65), auto-capture interval in metres
   (default 8, 0 = manual only), session id (default `walk-YYYYMMDD-HHMM`) and
   a free-text note (for example "left side, Bhartendu Marg").

Each photo becomes a record `{photo, source=own, lat, lon, gps_accuracy_m,
heading_deg?, pitch_deg?, hfov_deg, captured_at, session_id, note, width,
height, heading_source}` posted as `multipart/form-data` to
`${VITE_API_URL}/images` (`heading_deg` / `pitch_deg` are omitted when
unknown). After a successful upload the page calls `POST /coverage/recompute`
at most once every 30 s so the map's coverage layer catches up.

### HTTPS requirement

`getUserMedia` (camera), `DeviceOrientationEvent` (compass) and high-accuracy
geolocation only work in a **secure context**: `https://` or `localhost` /
`127.0.0.1`. Over plain `http://` from a phone the page falls back to an
`<input type="file" accept="image/*" capture="environment">` so photos can
still be submitted (with GPS if the browser allows it) and explains why.

To test on a phone, run the dev server on all interfaces and put it behind an
HTTPS tunnel, or use a locally trusted certificate:

```bash
npm run dev -- --host            # listen on the LAN too
cloudflared tunnel --url http://localhost:5173   # or: ngrok http 5173
```

or with [mkcert](https://github.com/FiloSottile/mkcert) (`mkcert -install &&
mkcert 192.168.x.y`) and `server.https` in `vite.config.ts`. The API must also
be reachable from the phone (set `VITE_API_URL` to its tunnelled HTTPS URL to
avoid mixed-content blocking).

### Upload queue (IndexedDB)

Records are written to IndexedDB (`samaan-capture` / store `pending`, key =
`captured_at` + random suffix; `src/idb.ts` is a small promise wrapper with no
library) before upload, so a reload or a crash does not lose photos. Uploads
run sequentially; a failure keeps the record and retries with backoff (2 s,
4 s, 8 s ... max 30 s); while `navigator.onLine` is false the queue pauses
and resumes on `online`. The page shows captured / uploaded / pending / failed
counters, a **Retry now** button and the last error (translated text plus the
raw HTTP status). The queue lives in `src/uploadQueue.ts` as a module
singleton, so switching back to the map does not stop uploads.

## Where things live

- `src/api.ts` - TypeScript types for the API contract and typed fetch helpers.
- `src/i18n/en.json`, `src/i18n/hi.json` - every UI string. `src/i18n/index.ts`
  initialises i18next, persists the chosen language in `localStorage`
  (`samaan.lang`) and keeps `<html lang>` in sync.
- `src/components/MapView.tsx` - MapLibre map, sources/layers, popups.
- `src/components/BarrierList.tsx` - keyboard/screen-reader list of barriers.
- `src/components/Legend.tsx` - layer toggles and pattern legend.
- `src/components/Header.tsx` - app name, zone, Map/Capture navigation,
  language/contrast/panel controls.
- `src/components/CapturePage.tsx` - camera preview, sensors, settings, queue UI.
- `src/sensors.ts` - `useSensors()` (GPS, compass heading, pitch), haversine.
- `src/uploadQueue.ts` - persistent sequential upload queue with backoff.
- `src/idb.ts` - minimal IndexedDB wrapper (open, put, getAll, remove).
- `src/router.ts` - `useHashRoute()`, `navigate()`, `hrefFor()`.
- `src/styles.css` - mobile-first styles, light/dark/high-contrast tokens.
- `public/manifest.webmanifest`, `public/icon.svg` - PWA manifest (no service
  worker yet).

Barrier names in popups and the list use `name_en` / `name_hi` from the API;
the i18n files also carry the eight barrier class names for labels.

### Map layers added in P2

- **Images** (`GET /layers/images`, off by default): one small circle per
  camera position, coloured by source (own = magenta with a dark ring,
  Mapillary = teal, report = brown) with a black arrow rotated to
  `heading_deg` when a heading is known. Clicking shows source, time, heading,
  field of view, session id, the attribution text (always shown for
  Mapillary) and, when `has_photo` is true, the photo from
  `GET /images/{id}/photo` (lazy-loaded, translated alt text).
- **Image coverage** popups: clicking a coverage band shows observed /
  not observed, the number of images, the street side (`L` / `R` / `none`)
  and whether the coverage comes from real images, seeded demo data, a wheel
  survey or reports.

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

- [x] Capture page: controls in a sticky bottom bar, 64 px shutter, toggles use
      `aria-pressed`, GPS quality shown as colour **and** a word, sensor
      summary in a polite live region throttled to one update per 2 s, errors
      use `role="alert"`, page navigation uses `aria-current="page"`.

Not yet done (later phases): service worker/offline, keyboard navigation of
map features themselves (use the list), route planning UI.
