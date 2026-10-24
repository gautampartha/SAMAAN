# SAMAAN web (phone-first navigation PWA)

Vite + React 18 + TypeScript single-page PWA for SAMAAN: accessible walking
routes around footpath barriers (demo zone: Manipal University Jaipur campus),
in English and Hindi, phone-first (375-430 px; tablets and desktops centre a
430 px column), with accessibility built in from the start.

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
features. If the API is unreachable it shows a translated error, an empty map
and dashes in Statistics; the profile list falls back to a built-in copy of
the API's ids and modes.

## Environment

| Variable       | Default                  | Purpose                                                        |
| -------------- | ------------------------ | -------------------------------------------------------------- |
| `VITE_API_URL` | `http://127.0.0.1:8000`  | Base URL of the SAMAAN API (no slash): `/profiles`, `/route`, `/search`, `/zone`, `/layers/*`, `/images` (uploads and photos), `/coverage/recompute`, the citizen loop (`/users`, `/reports`, `/reports/{id}/votes`, `/missions`), the reach gap (`/reach/anchors`, `/reach`), ride mode (`/rides`, `/rides/{id}/samples`, `/rides/{id}/end`, `/rides/replay-demo`, `/layers/wheels`) |

## App shell

- **Status strip** (top): app name, zone name, the synthetic-data badge, and a
  polite live region for load errors.
- **Content**: the MapLibre map stays mounted behind Home, Navigate, Explore,
  Listen, Map and Reach Gap; the other pages scroll.
- **Tab bar** (bottom, 4 tabs, `aria-current="page"` plus a filled pill and an
  underlined label): **Home**, **Navigate**, **Contribute**, **More**. The tab
  bar hides while a trip is being navigated (the End button is always on screen).

Hash routes (`src/router.ts`, no library): `#/home` (default), `#/navigate`,
`#/explore`, `#/listen`, `#/contribute`, `#/more`, and under More: `#/map`
(layers, legend, barrier list, report button), `#/validate`, `#/missions`,
`#/reach`, `#/ride`, `#/capture`, `#/stats`, `#/settings` (language, contrast,
profile, risk, who you are).

Design tokens live in `src/styles.css` (`--c-bg #FAFAF9`, `--c-primary
#1561F1`, `--c-ink #000`, `--c-card #fff`, `--r-card 18px`, `--shadow-card`,
system font stack with Noto Sans Devanagari). The high-contrast theme
(`samaan.theme` in localStorage, or `prefers-contrast: more`) switches the same
tokens to black / white / yellow.

## Three modes, one trip engine

`GET /profiles` gives each profile a **mode**; picking a mode on Home switches
to a matching profile and picking a profile in Settings switches the mode.

| Mode | Who | Screen |
| ---- | --- | ------ |
| **Move** | wheelchair, walking aid, pram | map, two route cards, black turn banner, bottom sheet with arrival / minutes / km and a blue progress bar |
| **Explore** | dyslexic / autistic travellers | camera full screen, one huge arrow, a pictogram and at most four words per step, the distance as a big number, a Simplify toggle |
| **Listen** | blind / low-vision travellers | one giant button, spoken prompts and instructions, voice input for the destination and commands |

### Home (`#/home`, `src/components/HomeSheet.tsx`)

Greeting (with the display name once "Who are you?" was answered), a big
**Where to?** combobox (`src/components/PlaceField.tsx`: debounced
`GET /search`, listbox with Up/Down/Enter/Escape, **Pick on map**), a **From**
row that defaults to the GPS position (**Change** opens an origin field with
**Use my location** and **Pick on map**), the three mode cards (native radios,
checked = thick blue border + filled icon + check mark), the profile chip,
**Options** (risk tolerance, departure time) and **Try the demo trip**
(`GET /route?demo=riya`). **Show routes / Start Explore / Start Listen**
resolves the origin (GPS, or the chosen point), calls `GET /route` and either
shows the two cards (Move) or starts navigating the SAMAAN route at once
(Explore, Listen). Without GPS the error says how to set an origin or try the
demo.

### Route choice (Move, `#/navigate`, `src/components/RouteChoice.tsx`)

Two cards side by side: **Standard route** (what a normal map suggests) and
**SAMAAN route** (Recommended). Each shows minutes, km, a **confidence ring**
(SVG; the percentage inside, the label high / medium / low as text), "n
barriers (m impassable)" and "x% checked · y segments without recent
imagery". The cards are `aria-pressed` buttons whose accessible name is the
full summary; tapping one previews it on the map (the other line is dimmed)
and **Start** begins navigation. **Details** lists the barriers (with **Report
as fixed**), the unknown stretches and every turn-by-turn step with its
pictogram. `naive_accessible` from `&modes=all` is typed but never shown.

### Navigation (Move, `src/components/NavigationScreen.tsx`)

- Black **turn banner**: step pictogram, distance to the step (rounded to 5 m
  under 100 m, 10 m above), the instruction in the current language, the
  street name. Warnings on the upcoming step are orange chips under it (red
  for "impassable for this profile"), always with text.
- The map follows the GPS position (`watchPosition` through `useSensors`), a
  blue dot with a halo; panning stops following and a **Re-centre** button
  appears. Route lines: SAMAAN thick solid blue with a white casing, standard
  thinner dashed grey with a white casing; black A / blue B pins.
- **Simulated walk**: offered when GPS is denied, missing after 8 s, or the
  fix is more than 50 m from the route. It moves a white dot with a blue ring
  along the route at 1 m/s (×5 / ×20 for demos), labelled "not your real
  position", and never feeds the photo contribution.
- Bottom sheet: arrival time, minutes left, km left, blue progress bar, the
  confidence sentence. Round floating buttons: mute / unmute voice, report a
  barrier (the existing report sheet), re-centre, end.
- Step engine (`src/navigation.ts`, shared by all three modes): the current
  step is the first step whose along-route distance is more than 8 m ahead of
  the projected position (`src/geo.ts`); each new step is announced once
  (speech + `aria-live="assertive"`); arrival within 8 m of the end shows a
  summary (km, minutes, confidence) and, when contribution was on,
  "Contribute photos of this trip?".

### Explore (`#/explore`, `src/components/ExploreScreen.tsx`)

Camera feed full screen (`useCamera`; without a camera the map shows
instead). One huge arrow rotated to (bearing to the next step − device
heading), snapping to the eight compass directions within 15°; the heading is
the compass when available, else the direction of travel, else the route
bearing (the fallback is named in an sr-only line). A large pictogram for
the step type, at most four words ("Turn right", "Cross the road"), the
distance as a big number with "m". Calm colours: blue arrow, white panels; the
only red is the impassable warning icon. No animation except the arrow
rotation, and none under `prefers-reduced-motion`. **Simplify** keeps only
the arrow and the distance (remembered in `samaan.explore.simplify`).

### Listen (`#/listen`, `src/components/ListenScreen.tsx`, `src/speech.ts`)

One giant button toggles listening (`SpeechRecognition` /
`webkitSpeechRecognition`, `hi-IN` or `en-IN`). Output uses
`speechSynthesis` with a Hindi / Indian-English voice when the device has
one; a new step cancels what was being said.

Voice flow: say a place → `GET /search` → the top result is read back →
"Say yes to go" → the route is fetched and navigation starts with "SAMAAN
route, confidence high, 95 percent checked" and the first instruction. While
navigating: **repeat** (दोबारा), **where am I** (मैं कहाँ हूँ: current street
and distance to the next step), **stop** (रुको). Also **demo** / **रिया** for
the demo trip and **no** / **नहीं** to pick another place. Double-tapping the
screen repeats the current step.

Everything also works without speech: a typed destination field with
**Find**, **Yes, go to …** / **No, another place**, and **Repeat / Where am
I? / Stop** buttons; every prompt is shown in an `aria-live="assertive"`
box. Missing APIs show a clear message (no voice input, no speech output, or
neither) and the text flow remains.

### Contribute (`#/contribute`, `src/components/ContributePage.tsx`)

A `role="switch"` **Contribute photos while I navigate** (`samaan.contribute`).
When on, Move-mode navigation runs a hidden camera and queues a photo every
10 m of real GPS movement through the existing upload queue with session id
`nav-<YYYYMMDD>`; never during the simulated walk. The page also shows the
upload queue counters and links to Capture, Ride, Missions and Report.

### Statistics (`#/stats`, `src/components/StatsPage.tsx`)

2×2 cards computed on the phone: footpath km checked (clear + blocked length
from `/layers/footpaths`, with a tiny clear / blocked / unknown bar), barriers
verified (active count from `/layers/barriers`, sparkline by severity),
reports pending (`GET /reports?status=pending` count), segments verified by
wheels (`/layers/wheels`), plus **Confidence of your last route**
(`samaan.lastConfidence`, written when a trip starts). Each card has a full
text alternative; the mini charts are decorative.

### Keyboard-only flows

- **Move**: Tab to **Where to?**, type, Down/Enter to choose; Tab to **Show
  routes** (or **Try the demo trip**), Enter. Focus lands on the route-choice
  heading; Tab to a card (Enter previews it), then **Start**. Focus moves to
  the turn banner; Tab reaches voice / report / end and, when offered,
  **Simulate walk**. Escape in the suggestion list closes the list first.
- **Explore**: the same start; on the screen, Tab cycles Simplify / voice /
  report / end.
- **Listen**: Tab to the typed destination field, type, Enter; Tab to **Yes,
  go to …**; while navigating, Tab to Repeat / Where am I? / Stop.
- Legend and barrier list on the Map page: opening moves focus to the
  heading, Escape closes and returns focus to the pill button.

## Citizen loop: Report → Validate → map/route update (P7)

No login: the first time someone reports or validates, a small **"Who are
you?"** dialog (`src/components/UserDialog.tsx`) asks for a display name and a
mobility profile (walker / manual wheelchair / elderly with walking aid / pram)
and calls `POST /users`. The result `{id, display_name, trust_score, profile}`
is kept in `localStorage` under `samaan.user` (`src/user.ts`, a tiny external
store shared by every page). The report sheet and the validate page show a
chip "You: Riya · Trust 0.30 · new" (levels: new < 0.4, regular < 0.7,
trusted) with a **Change** button that re-opens the dialog; the trust score is
refreshed from `GET /users/{id}` after every report and vote. A 404 from that
refresh (API reseeded) clears the stored user so the dialog shows again.

### Report a barrier (`src/components/ReportSheet.tsx`)

Opened by the floating **Report a barrier** button on the map (56 px, bottom
right, hidden while the planner or pick-on-map is active), by the same button
at the bottom of the route planner, by **Report as fixed** in a barrier popup
and by **Report as fixed** on a barrier row of a route card. The sheet is a
modal (`role="dialog"`, `aria-modal`, Tab trapped, Escape closes, focus moves
to the heading on open and back to the opener on close; a bottom sheet on
phones, a 560 px card on wider screens):

1. GPS and compass start immediately (`useSensors()` from `src/sensors.ts`);
   the current position, accuracy and quality word are shown in a live region.
2. Camera preview through the shared `useCamera()` hook (`src/camera.ts`, also
   used by the capture page); **Take photo** grabs a JPEG frame, **Retake**
   restarts the preview. Without a secure context or camera permission the
   `<input type="file" capture="environment">` fallback is offered. The photo
   is optional (strongly encouraged) for a barrier and required for a fix.
3. Class picker: big icon tiles (emoji glyph hidden from AT + localised name),
   the eight detector classes first, then the report-only classes under
   "Other" (no footpath, footpath ends, waterlogging, construction, lift out
   of service, foot overbridge stairs only). Native radios, so arrow keys work.
4. Severity 1-5 as five large tiles with a bar pictogram and the word (Minor,
   Low, Moderate, High, Impassable). Checked tiles get a thicker border, a
   tint **and** a check mark.
5. Optional note, then **Send report**.

The multipart `POST /reports` carries `lat`/`lon` = the GPS fix at the moment
the photo was taken (or the current fix without a photo) and
`device_lat`/`device_lon` = the current fix, plus `heading_deg`, `pitch_deg`,
`hfov_deg` (the capture page's setting), `captured_at`, `kind` and
`target_barrier_id` for fixes. The marker cannot be dragged (not implemented),
so the two positions are always the phone's position. States: sending
(`role="status"`) → "Report sent, pending validation." with the prescreen line
("Our detector also sees: Steps (0.82)" / "Detector did not recognise it;
validation needed.") and a duplicate hint when `duplicate_of_barrier_id` is
set → or an error (`role="alert"`): 429 rate limit, 422 `gps_offset` ("Your
photo location is more than 50 m from where you are"), 404 unknown target,
other 422, generic. Pending barrier reports from this session are drawn on
the map as a hollow blue circle with a "?" (see the legend) until a layer
refresh shows them as real barriers.

**Report as fixed** opens the same sheet with `kind=fixed`: class and
severity are shown from the barrier and locked, the photo is required.

### Validate (`#/validate`, `src/components/ValidatePage.tsx`)

Loads `GET /reports?status=pending&near_lat&near_lon&radius_m=300&user_id`
with the phone's position (own reports are excluded by the API). If
geolocation fails or nothing is within 300 m it falls back to the newest
pending reports without `near_*` and says so. One card at a time (Project
Sidewalk style): big photo (or "No photo"), class, severity, note, distance,
time, status/votes/detector score, the target barrier for fixes, a 160 px
non-interactive MapLibre mini-map with the report marker (hidden when `/zone`
is unavailable), and three 72 px buttons **Agree / Disagree / Unsure** (glyph +
text + key badge). A vote posts to `/reports/{id}/votes`; the result line shows
the new score, vote count and status. When `resolved` is true the card
announces "Verified — the map and routes were updated." (or rejected / fixed)
and the app calls `refreshLayers()` and `routePlanner.rerun()`. **Next report**
takes focus after every vote so Enter continues; the next card's heading is
focused. 409 (own report) and 400 (already resolved) are explained and the
card can be skipped. Empty state: "Nothing to validate nearby." with **Check
again**.

### Missions (`#/missions`, `src/components/MissionsPage.tsx`)

`GET /missions?limit=10` as a ranked list: street name in the current
language, length, "needed by N routes", Open/Done badge (done rows are also
dashed and struck through). **Show on map** navigates to the map and draws the
mission's LineString as a thick dashed grey line with a white casing and the
street name along it (`missions` source/layer in `MapView.tsx`), fits the map
to it and shows a banner with a **Hide mission** button. **Walk this** stores
`mission-<id>` in `localStorage` `samaan.capture.session` and opens
`#/capture`, where the session id is prefilled. **Recompute** posts
`/missions/recompute` (busy state, about 10 s) and reloads the list.

### Live update plumbing

`App.tsx` owns `refreshLayers()` (reloads `/layers/footpaths` and
`/layers/barriers`, plus `/layers/coverage` when that layer is visible, and
drops pending markers whose report became a barrier) and the planner hook
exposes `rerun()` (repeats the last `/route` request, keeping the selected
card). Both run after a resolved vote and after a report that the API resolved
immediately, and `refreshLayers()` also runs whenever the user returns to the
map page from another page.

### Keyboard shortcuts

- Validate page: **1** = Agree, **2** = Disagree, **3** = Unsure (ignored while
  typing in a field or while the "Who are you?" dialog is open; each button
  also carries `aria-keyshortcuts`). After a vote, **Enter** on the focused
  **Next report** button continues.
- Report sheet and user dialog: **Escape** closes (focus returns to the
  opener), **Tab** cycles inside the dialog, arrow keys move within the class
  and severity tile groups.

## Reach Gap (`#/reach`, P8)

The headline number of the pitch: *"From Karkarduma metro, a walker reaches
X km of footpath in 10 minutes. A wheelchair user reaches Y. Fixing these 3
barriers doubles that."* State lives in `src/reach.ts` (`useReachGap(active)`),
the panel is `src/components/ReachPanel.tsx`, the blob styles are shared by the
map and the legend in `src/components/reachStyles.tsx`.

**Controls**: start point (`<select>` from `GET /reach/anchors`, localised
name plus kind, default the first metro station), profile radios (manual
wheelchair default, elderly with walking aid, pram; the walker is the baseline
so it cannot be chosen), time budget as 5 / 10 / 15 min segmented buttons
(`aria-pressed`), risk radios with the planner's labels (the initial value
comes from the planner's stored `samaan.route.risk`). Every change re-runs
`GET /reach?anchor=&profile=&cutoff_min=&risk=` (previous request aborted);
loading is a `role="status"` line, errors `role="alert"` with **Check again**
(404 → unknown start point, 422 → invalid request, else generic). A failed
base request clears the numbers; a failed simulation keeps them.

**Headline** (`.headline`): two tiles "Walker reaches **4.2 km**" /
"Wheelchair user reaches **1.6 km**", then "Reach Gap **2.6 km** (38%)" and the
sentence "A wheelchair user reaches 38% of what a walker reaches." Numbers are
one decimal via `Intl.NumberFormat`, 32 px on phones and 40 px from 768 px up.
Each tile's left border repeats its blob's outline pattern (solid / dashed /
dotted). A one-line explanation says what is measured: footpath length
reachable within the cutoff along the network, not an area. An sr-only
`aria-live` region announces "Walker 4.2 km, Wheelchair user 1.6 km, gap
2.6 km." (plus the simulated line) when a result arrives. `synthetic_overlay`
shows the synthetic badge with "Numbers come from seeded demo data until real
detections exist."

**Map** (`MapView.tsx`, props `reach`, `reachFixed`, `reachFocus`): walker hull =
light blue fill 25 % with a solid dark-blue outline; target hull = purple fill
35 % with a dashed outline; simulated hull = green fill 35 % with a dotted
outline drawn above the target. Fills sit below the footpaths, outlines above
them. The anchor gets a dark star (canvas image, no glyph needed) labelled
"Anchor: <name>"; the five fixes get numbered purple pins that turn green while
simulated. The map fits the walker hull when a new result arrives (not when
only the simulation changes, so a panned map stays put). The legend has a
"Reach from anchor" section whose swatches are described in words (pattern +
colour) and take their colours from `--reach-*` tokens, so high contrast turns
them into black solid / dashed / dotted outlines on grey fills.

**The city's to-do list**: one row per `FixItem`: rank, localised barrier name,
severity word, **+gain km** (sr: "Gains 1.2 km of reach; 2.8 km in total after
this fix"), cumulative "→ 2.8 km", cost "₹2–4 lakh (estimate)" (or "Cost: not
estimated yet"), "0.4 km per lakh" and the cost source when present, a **Show**
button (`aria-label` "Show <name> on the map": flies the map there, padding
clear of the sheet, and opens the barrier popup when the barriers layer knows
it) and a **Simulate fixing: <name>** checkbox (48 px row). The checked ids go
out as `fixed=11,12`; the response's `simulated` hull is drawn with a 600 ms
grow animation (fill-opacity 0 → 0.35 via `requestAnimationFrame`, skipped
under `prefers-reduced-motion`), the row gets a dotted green border, its pin
turns green and the headline gains "With these fixes: 3.9 km (gap 0.3 km)".
**Simulate all 5** / **Clear simulation** set or empty the whole set. Changing
the start point, profile, time budget or risk clears the simulation (the ranked
list changes).

### Keyboard-only flow

1. Tab to **Reach Gap** in the page navigation and press Enter: the page opens
   and focus moves to the "Reach Gap" heading; the first result loads for the
   default metro station.
2. Tab through start point (native select), profile radios (arrow keys), the
   5 / 10 / 15 min buttons and down to the to-do list; Space on a **Simulate
   fixing: …** checkbox re-runs the request, the live region reads the new
   numbers; Enter on **Show** flies the map.
3. Escape anywhere in the panel (or the × button) returns to the map page and
   puts focus back on the **Reach Gap** nav link; the result is kept for the
   next visit.

## Ride mode (`#/ride`, P9 "wheels as sensors")

A wheelchair user mounts the phone and rides; nothing to photograph. The
engine lives in `src/ride.ts` (a module singleton like the upload queue, so a
ride keeps recording while another page is shown and React StrictMode's
double-run effects never start or stop anything, only taps do); the page is
`src/components/RidePage.tsx`.

**Mounting the phone**: fix it firmly to the frame or an armrest, screen facing
up, with a case or strap so it cannot rattle (a loose phone records its own
rattling as jolts). Any orientation works: the engine picks the axis with the
largest mean magnitude (the one carrying gravity) as "vertical".

**HTTPS**: `devicemotion`, high-accuracy geolocation and the Wake Lock API only
exist in a secure context (`https://` or `localhost`); on plain `http://` the
page says "This device has no motion sensors or the page is not served over
HTTPS". See the capture page's HTTPS section for a tunnel / mkcert setup. iOS
additionally needs `DeviceMotionEvent.requestPermission()` from a user
gesture, so **Start ride** asks for it inside the tap (a refusal shows the
"permission denied" alert).

**Start ride** (64 px): asks for motion permission (iOS), then, if there is no
stored user yet, shows the "Who are you?" dialog and continues once it closes.
Sensors start first (`t = 0` is exactly `started_at`, nothing is lost while
the request is in flight), then `POST /rides {user_id, started_at, device}`
creates the ride. `devicemotion` is recorded at the event rate (about 50-60 Hz,
`accelerationIncludingGravity`, device frame, `t` from `performance.now()`
relative to the start, 3 decimals) and `watchPosition` (~1 Hz, high accuracy)
merges GPS fixes into the same stream: a sample with `lat`/`lon`
(`gps_accuracy_m`, `speed_m_s` when known) is a fix, the others carry only
acceleration. If no motion event arrives within 4 s the ride is abandoned
locally with the "no motion sensors" alert (desktop browsers define the event
but never fire it).

**Wake Lock**: `navigator.wakeLock.request('screen')` keeps the screen on; the
lock is re-acquired on `visibilitychange` when the tab comes back and released
on Stop. The status line says whether the screen is kept awake or the browser
cannot do it.

**Batches**: every 10 s the buffered samples (≈500 accelerometer samples +
≈10 fixes) become one batch, written to IndexedDB first (`samaan-capture` v2,
store `rideBatches`, key `${rideId}:${seq}`; the v1 → v2 upgrade only creates
the missing store) and *then* posted to `POST /rides/{id}/samples`; the row is
deleted once the server accepted it. A failure backs off (2 s, 4 s … 30 s) and
retries, the queue pauses while `navigator.onLine` is false and resumes on
`online`; 400/404 (ride ended / unknown) drops the batch and shows an alert.
Batches left from a previous page load are re-sent on the next visit. The
live counters show duration, samples, batches sent / pending, speed (km/h from
the last fix), the vibration RMS and "last jolt N s ago".

**Live RMS / jolt hint** (client-side only; the server decides what becomes
verified or suspected): every 250 ms over the last second, the axis with the
largest mean magnitude is taken as vertical, its 1 s rolling mean is
subtracted (a cheap high-pass), the RMS of that is the vibration level and its
peak above 6 m/s² marks "last jolt" (the counter tile gets a thicker orange
border and a "!" glyph for 3 s).

**Stop ride** (64 px, red border): sensors off, the remaining samples become a
last batch, the queue is flushed (while flushing: **Retry now** and **End
without the pending batches**), then `POST /rides/{id}/end {ended_at}` returns
the `RideSummary`. A 400 on `end` (already ended, e.g. after a lost response)
falls back to `GET /rides/{id}`; any other failure keeps the ride id and
offers **Retry ending the ride**. The summary (focus moves to its heading)
says "You verified N footpath segments by wheels · M suspected barriers
found", shows duration, samples, windows matched / total, segments traversed,
a collapsible roughness list (top 8 segments by `roughness_index`), the
synthetic badge when `synthetic` is true, **Show on map** and **New ride**.

**Show on map** turns the **Wheels** layer on, navigates to the map, runs
`refreshLayers()` (footpaths/barriers changed: verified states, suspected
barriers), reloads `GET /layers/wheels` and fits the map to the LineStrings
whose `edge_id` is in `verified_edge_ids` (or to every wheels line when none
matches).

**Replay demo ride** (secondary button under "No wheelchair in the room?",
synthetic badge): `POST /rides/replay-demo {user_id}` makes the server generate
and process a synthetic ride along Riya's route; the same summary view and
Show on map follow, so the pitch can show segments turning "verified by
wheels" without a wheelchair.

**Map** (`MapView.tsx`, layer key `wheels`, off by default): verified edges are
a double line like a rail (9 px green casing with a 3 px white core, a pattern
and not only a colour), other traversed edges a thin orange-brown line; both
open a popup with the roughness index (m/s²), traversals and last traversed
time. Jolt points are hollow orange circles with a "!" glyph; their popup
shows the class, peak m/s², "Suspected — needs a photo" and a
**Photograph this** button that opens the report sheet with `kind=barrier`,
the class pre-selected and the barrier position fixed to the jolt (the sheet
says so; the phone's own fix is still sent as `device_lat/lon`, so the API's
50 m check applies). The legend has a "Wheels as sensors" section describing
the three symbols in words. `/layers/footpaths` may now carry `observed_by`
(`image` | `wheel` | `report` | null); it is typed in `api.ts` but there is no
footpath popup yet to show it. `/layers/barriers` may include status
`suspected`.

**Missions page**: a second list, **Photograph these jolts**, built from the
Point features of `/layers/wheels` sorted by peak: name, class, peak m/s²,
synthetic badge, **Show on map** (opens the map with the Wheels layer on, flies
to the jolt and opens its popup, where **Photograph this** is one tap away).

### Keyboard-only flow

1. Tab to **Ride** in the page navigation, Enter: the page opens.
2. Tab to **Start ride**, Enter (on iOS the permission prompt appears; without
   motion sensors the alert explains why). If no user is stored the "Who are
   you?" dialog takes focus; Enter on **Continue** carries on with the ride.
3. While recording the status line (`role="status"`) and an sr-only live
   region (one summary every 5 s, plus "Jolt felt.") report progress; Tab
   reaches **Stop ride**, Enter stops and flushes.
4. Focus moves to the "Ride summary" heading; Tab to **Show on map** (Enter
   opens the map with the Wheels layer on) or **New ride** (focus returns to
   **Start ride**).
5. **Replay demo ride** is reachable the same way from the start screen and
   ends on the same summary.

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

- `src/api.ts` - TypeScript types for the API contract (profiles, the two
  routes with confidence and steps, barriers, reports, reach, rides) and typed
  fetch helpers.
- `src/i18n/en.json`, `src/i18n/hi.json` - every UI string (key parity is
  checked by hand; `src/i18n/index.ts` initialises i18next and persists
  `samaan.lang`).
- `src/router.ts` - hash routes, tabs, `MORE_ROUTES`, `MAP_ROUTES`.
- `src/App.tsx` - shell, data loading, mode/profile coupling, the trip flow
  (Go → routes → choice or auto-start), report sheet, legend / list panels.
- `src/components/Shell.tsx` - status strip and tab bar.
- `src/components/HomeSheet.tsx`, `PlaceField.tsx` - Home sheet and the search combobox.
- `src/components/RouteChoice.tsx`, `ConfidenceRing.tsx`, `StepGlyph.tsx` - the two cards, the ring, step pictograms.
- `src/components/NavigationScreen.tsx` - turn banner, bottom sheet, floating buttons, simulation bar, arrival summary, hidden contribution camera.
- `src/components/ExploreScreen.tsx`, `ListenScreen.tsx` - the other two modes.
- `src/components/useAnnouncer.ts` - announcement → spoken text + live region.
- `src/navigation.ts` - `useNavigation()` step engine (GPS or simulated position, projection, step advancement, announcements).
- `src/geo.ts` - polyline distances, projection, bearings, eight-way snapping, distance formatting.
- `src/speech.ts` - speech synthesis / recognition wrappers and the yes / no / repeat / where / stop / demo command matcher (English and Hindi).
- `src/mode.ts` - small persistent stores: mode, contribute consent, last confidence.
- `src/components/ContributePage.tsx`, `StatsPage.tsx`, `SettingsPage.tsx`, `MorePage.tsx`.
- `src/components/MapView.tsx` - MapLibre map, sources/layers, popups, route lines, user dot and follow mode.
- `src/components/BarrierList.tsx`, `Legend.tsx` - screen-reader list of barriers, layer toggles and pattern legend.
- `src/components/routeStyles.tsx` - shared line styles / swatches for the two routes, the unknown overlay, the barrier ring and the user dot.
- `src/routePlanner.ts` - `useRoutePlanner()` (origin / destination, profile list from `/profiles`, risk, time, the `/route` result, `rerun()`).
- `src/components/CapturePage.tsx` - camera preview, sensors, settings, queue UI.
- `src/components/ReportSheet.tsx` - "Report a barrier" / "Report as fixed" modal sheet.
- `src/components/UserDialog.tsx` - "Who are you?" dialog, `UserChip`, Tab trap helper.
- `src/components/ValidatePage.tsx`, `MissionsPage.tsx`, `ReachPanel.tsx`, `reachStyles.tsx`, `reach.ts`, `RidePage.tsx`, `ride.ts` - unchanged P7-P9 pages.
- `src/user.ts`, `src/camera.ts`, `src/sensors.ts`, `src/uploadQueue.ts`, `src/idb.ts` - identity, camera, GPS/compass, upload queue, IndexedDB.
- `src/styles.css` - tokens, shell, sheets and the older page styles; light and high-contrast themes.
- `public/manifest.webmanifest`, `public/icon.svg` - PWA manifest (no service worker yet).

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
- [x] Panels (planner, legend, barrier list): opening moves focus to the
      heading, closing returns it to the opener, Escape closes.
- [x] Route planner: combobox/listbox search with `aria-activedescendant`,
      pick-on-map announced via `aria-live`, radio groups with visible
      labels and emoji glyphs hidden from AT, stacked bar as `role="img"`
      with a text alternative, sr-only route summaries, `aria-pressed` on
      card selection and tab strip `aria-current`, pulsing rings disabled
      under `prefers-reduced-motion`, SAMAAN emphasis by border width plus a
      text badge, route styles differ by width and dash, no horizontal page
      scroll at 360-375 px (the card strip scrolls inside the sheet).

- [x] Citizen loop: modal sheet/dialog with `aria-modal`, Tab trap, Escape and
      focus return; class/severity tiles are native radios with a check mark
      plus border for the checked state; vote buttons 72 px with glyph, text
      and visible key badge; vote results and resolutions in live regions;
      pending-report marker has a "?" label and a legend row; mission line is
      dashed with a casing and a text label.

- [x] Reach Gap: focus moves to the heading on open and back to the nav link on
      close/Escape; headline numbers in plain text with an sr-only live
      summary; blobs differ by outline pattern (solid / dashed / dotted) and the
      headline tiles repeat those patterns; legend swatches use high-contrast
      tokens; simulate checkboxes are native inputs in 48 px rows with labels
      that say what they do; grow animation disabled under reduced motion.

- [x] Ride mode: Start/Stop are 64 px with a glyph plus text; the jolt tile adds
      a thicker border and a "!" glyph (not colour alone); counters that change
      4×/s are plain text while an sr-only live region summarises every 5 s;
      errors in `role="alert"`, phases in `role="status"`; the summary heading
      takes focus; wheels symbols differ by pattern (rail vs. thin line vs.
      hollow circle with "!") and the legend describes them in words; the
      synthetic badge marks the demo ride.

- [x] Phone-first shell: 4-tab bar with `aria-current`, a filled pill and an
      underlined label; status strip live region; no horizontal scroll at
      375-430 px; wider screens centre a 430 px column.
- [x] Mode cards and profile radios are native inputs; the checked state is a
      thick border plus a check mark; every radio has a full accessible name.
- [x] Route cards: `aria-pressed` buttons whose name is the whole summary
      (minutes, km, checked %, barriers, confidence); the confidence ring is
      `role="img"` with the label as text; routes differ by width and dash.
- [x] Navigation: the turn banner takes focus on start, step changes go to an
      `aria-live="assertive"` region and (unless muted) to speech; warnings are
      chips with text; the simulated walk is labelled as simulation; the
      progress bar is a `progressbar` with a value.
- [x] Explore: dyslexia-friendly text (letter-spacing 0.06em, line-height 1.6,
      left aligned, no italics, no all-caps), at most four words, no red except
      the impassable icon, arrow rotation is the only motion and is static
      under reduced motion; Simplify is `aria-pressed`.
- [x] Listen: giant `aria-pressed` button; every prompt in an assertive live
      region; typed destination, Yes / No and command buttons as the keyboard
      and no-speech path; clear messages when speech APIs are missing.
- [x] Contribute switch is `role="switch"` with the state in words; photos are
      never captured from simulated positions.
- [x] Statistics cards carry full text alternatives; the bars and sparkline are
      decorative.

Not yet done (later phases): service worker/offline, keyboard navigation of
map features themselves (use the list), dragging the report marker on a mini
map.
