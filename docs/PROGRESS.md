# SAMAAN progress log

Single source of truth for scope and phases: `SAMAAN_PLAN.md`. This file records, per phase,
the plan, what was built, how to run it, open issues and **Human tasks**.

Rule reminders (plan section 11): one phase at a time; no fabricated metrics; every threshold in
`config/*.yaml`; `TODO: cite` for Indian standard values until a human confirms them; synthetic
data is flagged `synthetic=true` and never enters `eval/results/`.

---

## Phase P0 — Foundations (2026-10-24)

### Plan (agreed before starting)
Repo layout, five config files, SQLModel data model, `make seed` (real OSM graph of the zone +
synthetic barriers/coverage + Riya's demo trip), FastAPI with GeoJSON layer endpoints, offline
test suite, React/MapLibre PWA scaffold with Hindi/English and accessibility baked in.
Decisions taken: zone bbox 28.6430–28.6538 N, 77.2993–77.3115 E (~1.2 km square around
Karkarduma metro); anchors auto-discovered from OSM and flagged unverified; OSM fetched via the
main API because Overpass is blocked on the build network; OpenFreeMap basemap; AGPL-3.0 licence;
Riya's destination is an OSM node picked ~800 m walking distance from the metro, flagged synthetic.

### What was built
- **Config** (`config/`): `zone.yaml` (bbox, CRS EPSG:32643, anchors, demo story), `profiles.yaml`
  (4 profiles; standards all `TODO: cite`; speeds are placeholders with `TODO: cite`; barrier
  rules labelled `team_estimate`), `taxonomy.yaml` (8 detector classes with YOLO indices and
  Hindi names, report-only classes, tags, severity scale), `fix_costs.yaml` (all `TODO: estimate`),
  `pipeline.yaml` (coverage, geolocation, snapping, state, reach, missions, ride, seed params).
- **Core** (`common/`): config loader, CRS helpers (WGS84 ⇄ EPSG:32643), `side_of_line` cross
  product helper, bearing/offset helpers, segment state rule (plan 6.5).
- **Data model** (`api/models.py`): every table from plan section 5 plus `Coverage` (per edge
  side observation summary), `Anchor`, `DemoRoute` and `Meta` (provenance). `synthetic` flag on
  every table that can hold made-up data; edges carry `state_synthetic` separately because their
  geometry is real OSM while their seeded state is not.
- **Graph** (`pipeline/graph/`): downloads the zone as OSM XML from `api.openstreetmap.org`
  (cached in `data/raw/`), applies osmnx's walk filter, simplifies, keeps the largest component,
  projects to EPSG:32643 and writes an **undirected** P0 graph (one row per way segment, side =
  none). Anchors are snapped to the nearest node. ODbL attribution stored in `Meta`.
  P1 replaces the edge set with synthesised left/right sidewalks behind the same `write_graph`.
- **Seed** (`pipeline/seed/synthetic.py`): deterministic (seed 42). Builds Riya's trip from the
  metro anchor to a node ~800 m away and places her three story barriers on the shortest path
  (two steps, high kerb with no ramp, parked two-wheelers), then 30 random barriers, coverage
  rows for every edge (60% observed), and segment states via the plan 6.5 rule. Temporary
  classes get a synthetic 24-hour presence profile.
- **API** (`api/`): `GET /health`, `/zone`, `/meta`, `/layers/footpaths|barriers|coverage|anchors|demo`
  (GeoJSON FeatureCollections with `attribution` and a top-level `synthetic` flag). NetworkX graph
  loaded in memory at startup. CORS for the Vite dev server.
- **Web** (`web/`, React 18 + Vite 6 + TypeScript strict + MapLibre 5 + i18next): full-screen map
  on the OpenFreeMap basemap, fitted to the zone; footpaths drawn by state with distinct
  patterns (clear solid green, blocked dotted red, unknown dashed grey), coverage band (off by
  default), barriers as severity-sized circles with the severity number, anchors with localised
  labels, Riya's demo path with A/B endpoints; popups show localised class, severity text,
  status, permanent/temporary, tags, confidence and a "synthetic demo data" badge. A keyboard
  "Barrier list" panel is the screen-reader alternative to the map. English/Hindi toggle
  (persisted, `<html lang>` synced), high-contrast toggle plus `prefers-contrast`/dark tokens,
  skip link, 48 px targets, visible focus rings, `aria-live` load status, bottom-sheet panels on
  phones. Verified in the browser against the live API: layers, Hindi UI, popup, Devanagari map
  labels (OpenFreeMap's glyphs include it). No service worker yet (manifest only).
- **Tests** (`tests/`, 38 passing, offline): config rules, CRS round trip and metric lengths,
  side-of-line on straight/reversed/bent lines, state rule, seed invariants on a toy 5×5 grid
  (barriers on existing edges, positions within length, demo barriers on the demo path, steps
  block / bikes only penalise, idempotent reseed), API layer contracts.

### Zone facts from `make seed` (real OSM graph, synthetic overlay)
| Item | Value |
|---|---|
| Walkable OSM graph | 353 nodes, 472 segments, ~35 km (both directions counted once) |
| Anchors | 1 from config (metro, Nominatim position) + 4 discovered in OSM (2 bus stops, 1 school, 1 hospital), all `verified=false` |
| Riya demo trip | 797 m over 13 segments, 3 story barriers |
| Seeded barriers | 33 (all `synthetic=true`) |
| Seeded states | 264 clear / 19 blocked / 189 unknown (all `state_synthetic=true`) |

These are descriptive counts of the seed, not evaluation results.

### How to run
```bash
make setup                     # once: uv venv (Python 3.11) + deps
make seed                      # OSM download (cached) + graph + synthetic overlay -> data/processed/samaan.sqlite
make test                      # 38 tests, no network needed
make api                       # http://127.0.0.1:8000  (try /docs, /health, /layers/barriers)
make web-install && make web   # http://127.0.0.1:5173  (set VITE_API_URL if the API is elsewhere)
```
`SAMAAN_DB=/path/x.sqlite` points the API and scripts at another database (used by tests and,
later, by demo mode). `python -m pipeline.graph.build --force-download` refreshes the OSM cache.

### Open issues
- Overpass is unreachable on the build machine, so osmnx's own downloaders are bypassed. The OSM
  API path is fine for this zone size (bbox must stay under 0.25 deg² and 50k nodes).
- The metro anchor snapped 108 m to the nearest walkable node: OSM's station node sits on the rail
  line, and the bbox has no `railway=subway_entrance` nodes. Needs real exit positions (human task).
- P0 edges are OSM walkable ways (roads included) with `side=none`; "footpath" semantics arrive in P1.
- Eight pairs of parallel OSM ways collapse to one edge in the in-memory routing graph (shortest kept).
- Speeds in `profiles.yaml` are placeholders flagged `TODO: cite`; routing (P5) must not ship
  pitch numbers until they are cited.
- The user-level ruff config enables many rule sets; the repo only ignores `B008` (FastAPI idiom).
- Web: MapLibre control strings (zoom, close) are set once at map creation and need a reload to
  re-translate; the attribution bar shows OpenFreeMap twice (style's own + ours); no footpath or
  coverage popups yet; `.claude/launch.json` has `api` and `web` entries for the desktop app's
  preview but they need the app's one-time launch approval.

### Human tasks
1. **Confirm the zone and anchors** (10 min). Open `config/zone.yaml`. Check the bbox covers the
   streets you want in the demo. For the metro, add one anchor per exit you will use, with its
   lat/lon taken on site (phone GPS at the exit gate), `verified: true`, and a `source` note.
   Delete or keep the four auto-discovered OSM anchors (their ids start with `osm_`).
2. **Riya's destination** (5 min). If you have a real address, add `destination: {lat, lon}` under
   `demo.riya` in `config/zone.yaml` and tell the agent; otherwise the seeded node (~800 m) stays.
3. **Fill the standards** (30 min, needs the PDF). In `config/profiles.yaml` under `standards`,
   set each `value` from the *Harmonised Guidelines and Standards for Universal Accessibility in
   India 2021* (MoHUA) and replace `TODO: cite …` with the section/page. Do the same for
   `speed_m_s.source` in each profile (any cited source; otherwise leave the TODO).
4. **Review Hindi strings** (15 min): `config/*.yaml` `hi:` entries and `web/src/i18n/hi.json`.
   The agent wrote them; a native speaker should correct register and terms. Flagged as unsure:
   `state.clear` "खुला" (maybe "बाधा-रहित"), `theme.highContrast` "उच्च कंट्रास्ट",
   `layers.coverage` "छवि कवरेज", `legend.title` "संकेत-सूची", `popup.permanence` "अवधि",
   `popup.confidence` "विश्वसनीयता", `legend.unknown` "धूसर", class names
   `bike_barrier` "साइकिल अवरोधक" / `curb_ramp` "कर्ब रैंप" (config uses "कर्ब रैम्प": pick one).
5. **Licence check** (2 min): confirm AGPL-3.0 is acceptable for the team (forced by Ultralytics).

---

## Phase P1 — Footpath graph (2026-10-24) — done

### Plan
Replace the P0 "roads as edges" graph with a real footpath network (plan 6.1):
offset left/right sidewalks per road (`shapely.offset_curve`, half width from `width` /
`lanes` / per-class default, +1 m), trimmed at junctions; crossing edges at every junction
(ring of sidewalk endpoints in angular order: same-road pairs = crossings, adjacent-road pairs =
corner links) and at every OSM `highway=crossing` node mid-block; real OSM footways/steps kept
and connected to sidewalks within 5 m; roads tagged `sidewalk=no` (and driveways) kept as
`road_shared`; OSM tags imported (sidewalk, kerb, crossing, wheelchair, width, surface, steps
attributes); `signal` and `kerb_ramp_start/end` on crossings from OSM, null = unknown.
Export to GeoJSON for QGIS/JOSM correction, import back, and a validation report (components,
dangling ends, crossings without ends). Tests on toy road layouts. "Resolve issues on your own"
was the instruction for this phase, so decisions are recorded here instead of asked.

### What was built
- `pipeline/graph/synthesize.py`: classification (sidewalk / shared / footway / steps),
  half width from `width` → `lanes` → per-class default (`config/pipeline.yaml`), left/right
  `offset_curve` at half width + 1 m, trimming at junctions by the crossing road's offset,
  fallback to `road_shared` when a trimmed sidewalk would be under 2 m, `sidewalk=left|right`
  honoured. Junction rule: each road's L/R ends form a **crossing** (also around dead ends);
  angularly adjacent roads get a **corner** link (kind sidewalk, tag `corner`); footways, steps
  and shared roads ending at the junction node get **connector** edges to every sidewalk end
  there. Mid-block OSM `highway=crossing` nodes split both sidewalks and add a crossing with
  `signal` / `kerb_ramp_*` from the node tags (`traffic_signals`, `crossing=*`, `kerb=*`).
  Dangling OSM footway ends connect to the nearest sidewalk within 5 m. Links shorter than
  0.5 m merge their end nodes, so right-angle corners share one node.
- OSM tag import: way tags (sidewalk, kerb, crossing, wheelchair, width, lanes, surface,
  smoothness, lit, step_count, ramp, handrail, incline, tactile_paving …) and node tags
  (crossing, kerb, traffic_signals, tactile_paving) are read via osmnx `useful_tags_*` and
  stored in `osm_tags`; crossing flags stay `null` when OSM is silent (= unknown).
- New edge columns: `synthesized`, `signal`, `kerb_ramp_start`, `kerb_ramp_end`; node `kind`
  `crossing_end` on crossing ends. Footpaths layer exposes them plus `corner` and
  `parent_road_osm_id`.
- `pipeline/graph/validate.py` (`make graph-validate`): components and length share, dangling
  nodes/edges by kind, crossings with a free end, edges under 0.5 m, counts and km by kind,
  unknown signal/kerb counts; writes `data/processed/graph_validation.md` and the Meta table.
- `pipeline/graph/export.py` (`make graph-export`) → `data/processed/footpath_graph.geojson`
  (+ `_nodes`), WGS84, one property per column, `osm_tags` as a JSON string for QGIS.
- `pipeline/graph/import_corrected.py` (`make graph-import FILE=…`): rebuilds nodes by merging
  endpoints within 0.5 m, keeps the original `id` as `osm_tags.import_id`, re-snaps anchors,
  records provenance in Meta and prints the validation report. `make seed` then restores the
  synthetic overlay without rebuilding the graph.
- Tests (54 passing): half-width parsing, classification, sides via the cross-product helper,
  dead-end crossings, 4-way ring (8 sidewalks, 4 centre crossings + 4 dead-end crossings,
  4 corners merged into shared corner nodes), T-junction signal/kerb propagation, `sidewalk=no`,
  left-only, mid-block crossing split with signal, far crossing ignored, footway connector within
  5 m (and dangling beyond), footway-at-junction hub, steps tags kept, short-stub fallback, 3×3
  and 5×5 grids (one component, no dangling ends), export → edit → import round trip.

### Zone results from `make graph` (real OSM, no synthetic content)
| Item | Value |
|---|---|
| Footpath graph | 1510 nodes, 2475 edges, 74.0 km |
| By kind | 1367 sidewalk (63.8 km), 896 crossing (8.1 km), 188 connector, 21 road_shared, 3 footway |
| Components | 1 (100% of length) |
| Dangling | 3 footway ends (OSM footways that reach nothing within 5 m) |
| Crossings with unknown signal / kerb ramp | 896 / 896 |
| OSM tags present in the zone | `highway=crossing`: 0, `traffic_signals`: 0, `kerb`: 0, `sidewalk`: 0 |

So every crossing in the zone is genuinely unknown until observed; OSM has mapped none of this.
Riya's trip now runs 800 m over 39 footpath edges (sidewalks + crossings).

### Decisions taken alone (per "resolve issues on your own")
- Roads without `sidewalk=*` get sidewalks on both sides; the human correction pass removes the
  ones that don't exist (likely many in the inner colony lanes).
- Service roads of type driveway / parking aisle / alley stay `road_shared`; other service roads
  get sidewalks.
- Connectors through a junction node (footway or shared lane meeting a road) are kind
  `connector`; P5 routing will price them like crossings.
- Generated GeoJSON exports and the validation report are gitignored; the corrected file goes
  in `data/corrected/` and is committed.

### Open issues
- Sidewalk offsets follow OSM centrelines; where OSM widths are missing the per-class default
  decides the offset, so sidewalks can sit on buildings along narrow lanes. Human correction.
- Road-level `wheelchair=no` / `surface` tags are stored but not yet used for state or routing (P5).
- The 3 dangling OSM footways are real map gaps; leave or fix in QGIS.
- Vite HMR logs WebSocket errors in the console when the dev server restarts under an open tab;
  harmless.

### Human tasks (P1)
6. **Correct the footpath graph in QGIS/JOSM (2–3 h).** `make graph-export`, open
   `data/processed/footpath_graph.geojson`, and for the streets in the demo zone: delete
   sidewalk edges where no footpath exists (or set `kind=road_shared`), move offset lines onto the
   real footpath, add missing footpaths/crossings as new LineStrings with `kind` and `side`, set
   `signal` true/false on crossings you know. Save as
   `data/corrected/footpath_graph_corrected.geojson`, then
   `make graph-import FILE=data/corrected/footpath_graph_corrected.geojson && make seed`.
   The validation report must still say one main component.

---

## Phase P2 — Ingest & capture (2026-10-24) — done

### Plan
Images with heading in, coverage out (plan 6.2): a Mapillary API v4 downloader (token from the
environment, attribution stored per image, optional thumbnail download), a `POST /images`
upload endpoint for our own photos (multipart, GPS + heading + pitch + HFOV + session), the
`#/capture` PWA page (camera preview, GPS watch, compass via DeviceOrientation incl. iOS
permission, auto-capture every N metres, IndexedDB upload queue), view-cone coverage
computation (camera within 15 m of the edge and heading ± HFOV/2 cone of 20 m intersecting it,
K = 2 images), a state recompute step that prefers real coverage over seeded coverage, an
images layer, and tests on toy edges/images. Decisions taken alone are recorded below.

### What was built
- `pipeline/ingest/mapillary.py` (`make ingest-mapillary`, needs `MAPILLARY_TOKEN`): Graph API
  v4 bbox query with paging, fields per plan 6.2 plus `camera_type`, `is_pano`, `sequence`,
  `creator`, `width`, `height`; computed geometry/heading preferred over raw; HFOV from
  `camera_parameters` focal (360° for panoramas); attribution string per image
  ("Mapillary image … by …, CC BY-SA 4.0 (link)"); dedupe on source id; `--download` stores
  2048 px thumbnails under `data/raw/mapillary/` (URLs expire). The HTTP layer is injectable, so
  the parser and paging are unit-tested from a recorded-style fixture without a token.
- `POST /images` (multipart): photo + lat/lon/accuracy/heading/pitch/HFOV/captured_at/session/
  note/size. Validates type (JPEG/PNG/WebP magic bytes), size (15 MB), ranges; stores the file
  under `data/raw/own/<session>/<id>.jpg` and a non-synthetic `image` row; then recomputes
  coverage + states in a background task and reloads the in-memory graph. `GET /images/{id}`,
  `GET /images/{id}/photo`, `GET /layers/images` (points with heading, source, attribution,
  session, has_photo), `POST /coverage/recompute`.
- `pipeline/coverage/compute.py` (`make coverage`): view-cone sector polygon (heading ± HFOV/2,
  20 m; full disc for 360° cameras), camera within 15 m of the edge, GPS accuracy ≤ 25 m, K = 2;
  images with no heading are skipped unless spherical; coverage rows per edge inherit the edge
  side; synthetic images are ignored. STRtree keeps it fast (thousands of images, 2.5 k edges).
- `pipeline/state/recompute.py`: single state rule for seed, coverage, reports and rides: real
  coverage (image/wheel/report) beats seeded coverage per edge; `state_synthetic` records which
  decided. `make seed` now uses it too.
- `api/db.py`: `add_missing_columns` adds new model columns to an existing SQLite file at
  startup (create_all never alters), so schema additions no longer require a rebuild.
- Web: hash router (`#/`, `#/capture`) with Map / Capture navigation; **capture page** with
  camera preview (environment camera, canvas → JPEG 0.85) and a file-picker fallback plus an
  HTTPS hint when the camera is unavailable; GPS watch with accuracy quality label
  (good ≤ 8 m, ok ≤ 20 m, poor), compass heading from `deviceorientationabsolute` /
  `deviceorientation` (`webkitCompassHeading` on iOS, iOS permission on the "Enable sensors"
  tap), pitch, live readouts plus a throttled screen-reader summary; settings persisted (HFOV
  30–120, auto-capture interval in metres, session id, note); auto capture when moved ≥ interval
  and accuracy ≤ 25 m; **IndexedDB upload queue** (sequential, backoff 2→30 s, pauses offline,
  survives reload, counters, "Retry now", translated errors) that posts to `POST /images` and
  debounces `POST /coverage/recompute`. Map: **images layer** (off by default; colour per source
  plus a ring for own photos, heading arrows, popup with time/heading/HFOV/session/attribution/
  photo), coverage popup (observed, image count, real vs seeded, side). Verified in the browser
  on a scratch DB copy: two uploaded test photos aimed at one sidewalk made it "observed by
  image" (K = 2) and the markers appeared with arrows; the live camera path cannot run in the
  desktop pane and is a human check. Test uploads were deleted afterwards; the real DB has no
  images.
- Tests (67+): view-cone geometry, image→edge rules (angle, distance, no heading, spherical, GPS
  accuracy, grazing), coverage counts/threshold/idempotence, real-over-seed state precedence,
  stale coverage → unknown, Mapillary paging/parsing/attribution/dedupe, upload validation and
  file round trip, images layer, recompute endpoint, DB migration.

### Zone results
`make coverage` on the real DB: 0 images yet (no token, no walks), so all 2475 edges keep their
seeded state. That is expected: real coverage arrives with the human tasks below.

### Decisions taken alone
- Coverage is per edge (the P1 graph already splits sides); `Coverage.side` mirrors the edge.
- Images with poor GPS (> 25 m) or no heading do not count toward coverage; they are kept for
  later detection work. Threshold lives in `config/pipeline.yaml`.
- Mapillary thumbnails are downloaded only with `--download`/`DOWNLOAD=1` (URLs expire) and are
  gitignored; the attribution string is stored on every row regardless.
- The capture page uses a hash router (`#/capture`) instead of adding react-router.
- Upload recompute runs in the background on every photo; `POST /coverage/recompute` exists for
  the capture page's debounced refresh.

### Open issues
- Coverage ignores occlusion and image quality (a blurred or night photo still counts).
- The heading on phones held flat or indoors is noisy; `heading_source=relative` images are
  accepted as-is. Consider a quality flag in P4 when geolocating detections.
- Camera and compass APIs need HTTPS on phones; the dev server is HTTP (see web/README.md).

### Human tasks (P2)
7. **Mapillary token** (5 min): create a free developer app at mapillary.com/dashboard/developers,
   copy the client token, then run
   `MAPILLARY_TOKEN='MLY|...' make ingest-mapillary DOWNLOAD=1` and `make coverage`.
   Report the printed counts in this file (they are facts, not synthetic).
8. **Photo walks** (2–4 h, two people): serve the app over HTTPS on the phone (see
   web/README.md), open `#/capture`, tap "Enable sensors", set the session id to
   `<street>-<side>` (e.g. `bhartendu-marg-L`), auto-capture every 8 m, and walk **both sides of
   every street** in the zone bbox holding the phone upright, camera facing along the footpath.
   Check the GPS quality label stays "good/ok"; stop and wait under open sky if it goes "poor".
   Afterwards `make coverage`, then confirm on the map that walked sidewalks turned clear.
9. **Review new Hindi strings** (10 min) in `web/src/i18n/hi.json`: the agent flagged
   "दिशा (हेडिंग)", "झुकाव (पिच)", "व्हील सर्वेक्षण" (wheel-sensor coverage), "सीड किया गया डेमो
   डेटा", "सापेक्ष (बिना कैलिब्रेशन) दिशा", "निरपेक्ष कम्पास", colour words "टील", "मैजेंटा",
   nav "फ़ोटो कैप्चर", "सत्र आईडी".
10. **Check heading on your phones** (10 min): on the capture page, point the phone north; the
   heading readout should be near 0°. If it is off by ~90° or mirrored, note the phone model here
   so the heading conversion can be fixed before the walks.

---

## Phase P3 — Detector (2026-10-24) — pipeline done, numbers pending labels

### Plan
No labelled Indian images exist yet, so P3 delivers the complete, tested pipeline and the
labelling guide, and the numbers come only from the human labelling task (plan 6.3):
dataset import from a Roboflow/CVAT YOLO export with a manifest (street per image from the
capture session id, Mapillary sequence, or nearest OSM road name), **split by street** with one
whole held-out test street, YOLO nano/small training with India-suited augmentation from
`config/train.yaml`, our own IoU-matched per-class precision/recall + AP50 metrics (unit-tested),
`ml/eval.py` writing to `eval/results/` only for real data, `ml/domain_gap.py` comparing a
non-Indian baseline (RampNet weights if usable, else a non-Indian-trained model) against ours on
the same test street through a class map, `ml/infer.py` batch inference into the `detection`
table, and a synthetic smoke dataset (`make ml-smoke`) that exercises split → train → eval →
domain gap → infer end to end while never touching `eval/results/`.

### What was built
- `docs/labelling_guide.md`: per-class "box this / not this / severity cues" table for the 8
  detector classes, severity in one sentence, boxing rules, QA (double labelling of the first 50,
  10 % second pass), Roboflow/CVAT export + import steps, street-naming rule.
- `ml/dataset.py`: `import` reads a YOLO export (Roboflow/CVAT layouts), maps class names to the
  taxonomy via ids, Project Sidewalk names and `aliases` (now in `config/taxonomy.yaml`), splits
  `class_3` severity suffixes into `severity_counts.json`, drops unknown classes with a count,
  matches filenames to the `image` table for lat/lon and street (session id → Mapillary sequence
  → nearest named OSM road → filename pattern → "unknown"), writes `manifest.csv` with a
  `synthetic` column. `split` keeps **whole streets** on one side: one held-out test street
  (given, or the one closest to 15 % of boxes), whole-street val, rest train; writes
  `data.yaml`, `train/val/test.txt`, `splits.json`.
- `ml/metrics.py`: greedy IoU matching per class, P/R at the configured confidence, AP50 with
  all-point interpolation, `None` (never 0) for classes without ground truth or predictions,
  markdown table. Unit-tested on toy boxes.
- `ml/train.py` (`make train NAME=…`): Ultralytics YOLO11n by default, augmentation from
  `config/train.yaml` (brightness/saturation jitter, small rotations, scale, shear, mosaic, mixup,
  copy-paste, random erasing for partial occlusion), deterministic seed, runs under `ml/runs/`.
- `ml/eval.py` (`make eval NAME=… WEIGHTS=…`): predicts on the test street, computes our metrics,
  writes `eval/results/detector_<name>_<tag>.{json,md}` with provenance. Refuses synthetic data.
- `ml/domain_gap.py`: same test street, baseline weights + class map from
  `config/domain_gap.yaml` (RampNet or a non-Indian-trained model, human task), side-by-side
  table; classes the baseline lacks are printed as "not in baseline".
- `ml/infer.py` (`make infer WEIGHTS=…`): detections for every stored real image into the
  `detection` table (pixel xyxy, image size, model name), idempotent per model.
- `ml/smoke_dataset.py` + `make ml-smoke`: 24 synthetic shape images over 3 fake streets →
  import (flagged synthetic) → split (test street gamma-lane) → 2 CPU epochs → eval → domain gap.
  Verified: it runs end to end and writes only to `data/processed/smoke_results/`;
  `eval/results/` stayed empty. Inference was checked on a scratch DB copy (rows written,
  rerun skips done images). The smoke numbers are meaningless by design and are not reported.
- Dependencies: ultralytics 8.4, torch 2.2.2 (the last build for Intel macOS, CPU only on this
  laptop), NumPy pinned < 2 and pandas < 2.3 to match it.
- Tests: 77 passing (metrics, class lookup, import/severity/manifest, street split invariants,
  filename street parsing, synthetic-results guard, plus everything earlier).

### Numbers
None. There are no labelled Indian images yet, so there is no detector result. The pitch gets
its detector numbers only from `eval/results/detector_karkarduma_v1_ours.md` after task 11.

### Decisions taken alone
- Severity is a per-box attribute; if the tool cannot export attributes, a `_<1-5>` class-name
  suffix is accepted and split on import.
- Street for Mapillary frames = sequence id (one drive/walk), which is the right unit to avoid
  leakage even when the sequence crosses two streets.
- Images matched to no DB row and with no street in the filename go to a street called
  "unknown", which is always placed in train and never chosen as the test street.
- YOLO11n is the default model (nano, CPU-trainable); switch to `yolo11s.pt` in
  `config/train.yaml` if a GPU is available.

### Open issues
- Training on this laptop is CPU-only (Intel Mac, no MPS/CUDA): 600–1000 images × 60 epochs at
  640 px will take hours. Use a Colab/Kaggle GPU or a teammate's Apple-Silicon/NVIDIA machine:
  copy `data/labels/<name>/` there, run `make train`, copy `best.pt` back.
- Ultralytics' built-in `val` mAP is not used for the pitch; our own matcher is, so eval and
  domain gap share one definition. Both can be reported if asked.
- Haze/blur augmentation beyond HSV/erasing would need `albumentations` (Ultralytics picks it
  up automatically if installed); not added.

### Human tasks (P3)
11. **Label 600–1000 images** (team, 4–6 h total). Follow `docs/labelling_guide.md`. Use the own
    photo-walk uploads first (filenames `<id>.jpg` under `data/raw/own/<session>/`), then
    Mapillary thumbnails. Export YOLO format, then:
    `python -m ml.dataset import <export_dir> --name karkarduma_v1` and
    `python -m ml.dataset split --name karkarduma_v1` (check the chosen test street in
    `data/labels/karkarduma_v1/splits.json`; pass `--test-street` to pick another whole street).
12. **Train and evaluate** (GPU machine, ~1 h): `make train NAME=karkarduma_v1` then
    `make eval NAME=karkarduma_v1 WEIGHTS=ml/runs/karkarduma_v1/weights/best.pt`; commit the
    files that appear in `eval/results/`. Then `make infer WEIGHTS=…` on the laptop with the DB.
13. **Baseline for the domain gap** (30 min): check github.com/ProjectSidewalk for RampNet
    weights that Ultralytics can load, note URL + licence + class names in
    `config/domain_gap.yaml`; if unusable, label ~200 non-Indian Mapillary images with the shared
    classes, train with `make train NAME=non_indian_v1`, and set those weights as the baseline.
    Then `python -m ml.domain_gap --name karkarduma_v1 --ours …`.
14. **Example photos for the guide** (20 min): two per class into `docs/labelling_examples/`.

---

## Phase P4 — Geolocate & snap (2026-10-24) — pipeline done, numbers pending detections + ground truth

### Plan
Turn detections into barriers on the right segment and side (plan 6.4): bearing from the box
centre and HFOV, ground-plane distance from the box bottom, pitch and camera height (clamped
1–25 m, fallback 6 m), position offset in EPSG:32643, side from the cross product against the
nearest road centreline (centrelines now stored by the graph build) cross-checked against the
object's side of the camera's travel direction, snap to the nearest footpath edge **on that
side** within 12 m, cluster per class and edge (4 m), one barrier per cluster with confidence from
GPS accuracy, distance, side agreement and sightings, severity from the class default until human
labels/reports exist, time-of-day profiles for temporary classes, then the shared state
recompute. A naive baseline (nearest edge to the camera, side ignored) and
`eval/snapping_eval.py` against `data/ground_truth/snapping.csv`. Plus `docs/gpu_training_handoff.md`
so the detector can be trained later on another machine.

### What was built
- `pipeline/geolocate/geolocate.py`: bearing from box centre and HFOV; ground-plane distance
  from the box bottom, VFOV derived from HFOV and aspect, pitch from the capture page
  (negative = tilted down), clamp 1–25 m, fallback 6 m when the box bottom is within 2° of the
  horizon; position offset in EPSG:32643; **side of road** from the cross product against the
  nearest stored road centreline (new `road_centreline` table written by the graph build, same
  L/R convention as the synthesised sidewalks), cross-checked against the object's side of the
  travel direction (previous image in the same session/sequence within 60 s and ≥ 2 m, else the
  heading); **side-aware snap** to the nearest edge on that side within 12 m preferring the matched
  road's own sidewalk, then any edge on that side, then crossings/footways; `naive_edge_id` =
  nearest edge to the camera, side ignored (baseline); confidence from GPS accuracy, distance,
  side agreement and whether an on-side edge was found (weights in `config/pipeline.yaml`).
- `pipeline/geolocate/barriers.py`: 1-D gap clustering per class and edge (eps 4 m, equivalent to
  DBSCAN with min_samples 1 along the edge), one barrier per cluster at the median position,
  confidence rises with sightings, severity = median of labelled severities when any exist else
  the class default (`barriers.default_severity`, team_estimate), temporary classes get a
  smoothed hour-of-day profile from sighting timestamps (flat 0.5 below 3 sightings). Only
  detector-derived barriers are rebuilt; report barriers are untouched.
- `make geolocate` runs locate → snap → barriers → shared state recompute. `GET /layers/detections`
  shows estimated positions, assigned vs naive edge and confidence for debugging.
- `eval/snapping_eval.py` (`make snapping-eval`): per ground-truth row (image, class, true edge,
  true side) compares the side-aware and naive snappers on edge and side accuracy; refuses
  synthetic images; writes `eval/results/snapping_<tag>.{json,md}`. Template in
  `data/ground_truth/snapping.csv.example`.
- `docs/gpu_training_handoff.md`: what to copy to a GPU machine, commands, what to bring back.
- Tests (86 passing): bearing wrap-around, VFOV, ground distance (fallback, clamp, pitch
  direction), image side, road side convention and travel flip, side-aware snap picks the far
  sidewalk the naive snapper misses, disagreement lowers confidence, clustering/confidence/
  profile, full DB pass with three sightings → one barrier (and a report barrier left alone),
  snapping eval bookkeeping and the synthetic guard.

### Numbers
None yet: snapping accuracy needs real detections (after the GPU training) and the ~100
ground-truth rows (task 15). `make geolocate` on the real DB is a no-op today (0 detections);
seeded barriers remain the demo content.

### Decisions taken alone
- Travel direction comes from consecutive images of the same walk when available; otherwise
  the compass heading stands in for it (a walker looks where they go).
- Severity for detector-only barriers is a per-class default until a human label or report
  supplies one; the default table is flagged team_estimate.
- Clustering is 1-D along the edge because the P1 graph already separates sides; this is what
  "same edge side" means after P1.
- Detections store the naive edge alongside the assigned edge so the eval can run later without
  re-snapping.

### Open issues
- Ground-plane distance assumes a flat footpath and the box bottom touching the ground; raised
  objects (signboards) will be placed too far. Plan 6.4 names a monocular depth model as the
  upgrade.
- Mapillary images have no pitch; 0 is assumed.
- Side disagreement is only detectable when GPS error moves the camera across the centreline;
  that is exactly the failure mode the snapping eval should expose.

### Human tasks (P4)
15. **Snapping ground truth** (~100 barriers, 1–2 h, after the photo walks). On the map with the
    images layer on, for a barrier visible in a photo note: the image id (popup), the class, the
    footpath edge id it really sits on (click the footpath), and that edge's side. Fill
    `data/ground_truth/snapping.csv` (see `snapping.csv.example`, remove comment lines). Commit it.
    After `make infer` + `make geolocate`, run `make snapping-eval` and commit `eval/results/snapping_*`.

---

## Phase P5 — Routing API
_Not started. Waiting for "go"._
