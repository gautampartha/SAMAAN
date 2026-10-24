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
   **Training images from the hackathon venue:** the detector only needs Indian footpath photos,
   so if the zone has few Mapillary images, pull a wider area for training only:
   `MAPILLARY_TOKEN='MLY|...' make ingest-mapillary DOWNLOAD=1 BBOX=77.20,28.55,77.40,28.72 MAX=3000`
   (east Delhi). Those images stay out of zone coverage (they are outside the bbox) but can be
   labelled and used for training; the importer uses the Mapillary sequence as the street.
   Also photograph footpaths around the venue with team phones (any Indian street works).
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

## Phase P5 — Routing API (2026-10-24) — done

### Plan
Plan 6.6: per-profile edge cost = length / speed + Σ barrier penalties (impassable edges
removed; temporary barriers weighted by P(present at departure hour) or impassable above a
probability threshold) + edge-kind rules (steps, crossings, carriageway walking, connectors)
+ unknown multiplier by risk tolerance (strict ×5 / balanced ×1.5 / relaxed ×1). NetworkX A*
with a straight-line-time heuristic. Three modes returned together: `shortest` (walker, ignores
barriers), `naive_accessible` (profile rules, unknown treated as clear), `samaan` (profile rules
+ unknown penalty). Response per route: geometry, length, ETA, barriers encountered with photo
URLs, verified % (clear length / total), unknown stretches with lengths. `GET /route` with
origin/destination or `demo=riya`. Unit tests on toy graphs; API test on the toy fixture.
All new rule values go in `config/profiles.yaml` as team_estimate.

### What was built
- `api/services/routing.py`: `RoutingContext` (graph, edge info, active barriers per edge with
  photo image ids) built from the DB at startup and refreshed after uploads/recompute or
  `POST /route/reload`. `edge_cost` implements plan 6.6: length / profile speed; edge-kind rules
  (`edge_kind_rules` in `profiles.yaml`: steps impassable for wheelchair and pram, crossing
  seconds signalised/unsignalised, a known-missing kerb ramp makes a crossing impassable for
  wheelchairs, carriageway walking multiplier, connector seconds); barrier penalties by class
  and severity with nearest-lower-severity lookup; impassable → edge removed; temporary
  barriers scaled by P(present at departure hour) or impassable above 0.6; unknown edges × risk
  multiplier in `samaan` mode only. A* with an admissible straight-line-at-fastest-speed
  heuristic (tested against Dijkstra). Three modes computed together.
- Route description: WGS84 geometry, length, ETA, edge ids, **verified %** (clear length /
  total), unknown %, blocked %, barriers encountered with class names (en/hi), severity, P(present),
  impassable-for-selected-profile flag and photo URLs, unknown stretches (contiguous unknown
  runs ≥ 5 m with start/end and length).
- `GET /route`: `from_lat/from_lon/to_lat/to_lon` snapped to the nearest node within 150 m, or
  `demo=riya`; `profile`, `risk`, `depart` (hour). Returns all three routes plus
  `synthetic_overlay` so the UI can badge seeded content. 422/404 on bad input.
- Tests (96 passing): severity lookup, permanent/temporary barrier costs, shortest ignores
  barriers while the wheelchair detours, unknown multiplier separates naive from SAMAAN,
  verified %/unknown stretches, steps and crossing rules, time of day flips a route,
  unreachable → null, heuristic optimality on a grid, API contract on the toy fixture.

### Demo trip on the real graph with the SEEDED overlay (illustrative, not an evaluation)
Wheelchair, strict, 14:00. These numbers come from synthetic barriers/coverage and will change
when real data replaces the seed; they only show the three-way comparison works end to end.

| mode | length | ETA | verified | unknown | barriers on the way |
|---|---|---|---|---|---|
| shortest (what a normal map does) | 800 m | 10.3 min | 69 % | 0 % | two steps, parked two-wheelers |
| naive accessible (unknown treated as clear) | 864 m | 16.5 min | 45 % | 55 % | "0 barriers", 6 unknown stretches |
| SAMAAN | 821 m | 19.6 min | 99.8 % | 0.2 % | one kerb ramp (positive), bikes with a time-weighted penalty |

### Decisions taken alone
- Impassability shown on the shortest route is judged for the selected profile, so the
  comparison view can say "this normal-map route sends a wheelchair over steps".
- Crossings cost a fixed number of seconds per profile; with a known missing kerb ramp they are
  impassable for wheelchairs (`kerb_ramp_missing_impassable`), unknown ramps are not (that is
  what the unknown multiplier is for once P2 coverage exists on crossings).
- Edges on the `shortest` route are priced at walker speed with no rules at all, per plan.
- `verified %` counts only `clear` edges; blocked-but-passable edges (penalty) are not verified.

### Open issues
- ETA includes penalties, so SAMAAN's ETA can exceed the naive ETA even when shorter; the UI
  should show length and ETA side by side and explain penalties.
- `nearest_node` is a linear scan (1.5 k nodes, fine); switch to a KD-tree if the zone grows.
- Routes are not cached; each request runs three A* searches (~ms on this graph).

### Human tasks (P5)
16. **Review profile rules** (30 min, with a wheelchair user if possible): `config/profiles.yaml`
    → `profiles.*.rules`, `edge_kind_rules`, `unknown_multiplier`,
    `temporary_impassable_probability`. Adjust severities that block or merely slow each profile.
17. **Fill the cited values** (same as task 3): `standards.*` and `speed_m_s.source` from the
    Harmonised Guidelines 2021 or another citable source, replacing every `TODO: cite`.

---

## Phase P6 — Web app core (2026-10-24) — done

### Plan
Make the map demo-able on a phone: a route planner (search, pick on map, my location, the
"Riya's trip" demo button, profile + risk + departure time), the three-panel comparison
(length, ETA, verified/unknown/blocked bar, barriers with photos, unknown stretches), three
distinguishable route styles on the map, barrier photos in popups, Hindi strings for all of it,
and an accessibility pass (plan 6.11: labels, focus order, Escape, 48 px, contrast, reduced
motion, screen-reader summaries, keyboard-only flow). Backend: a `place` table of named OSM
features in the zone (shops, schools, hospitals, stations, parks, streets) filled by the graph
build, and `GET /search` over places, anchors, streets and the demo destination.

### What was built
- Backend: `place` table filled from the cached OSM XML by the graph build (named nodes with a
  place-like tag, named ways at their centroid, same-name ways merged, streets deduplicated by
  name; 46 places in the zone) and `GET /search?q=&limit=` ranking anchors, the demo destination,
  places and streets by prefix / word-start / substring match with en/hi names and subtitles.
- Web (route planner on the map page, opened with "Plan route"): origin/destination fields with
  a debounced search combobox (listbox, keyboard navigation), "Pick on map" toggle, "Use my
  location"; the **"Riya's trip (demo)"** button; profile radios (walker, manual wheelchair,
  elderly with walking aid, pram), risk radios with one-line explanations, departure time
  (local offset sent, so the API sees the local hour); profile/risk persisted. **Three-panel
  comparison**: on phones a snap-scrolling strip with "1 Shortest / 2 Naive / 3 SAMAAN" tabs, on
  wider screens three cards docked under the map; each card has a screen-reader summary, mode
  explanation, length, ETA, a stacked verified/never-seen/blocked bar (`role="img"` + text), barrier
  count with impassable count, barrier rows (localised name, severity text, permanent/temporary,
  "likely present at this hour (77 %)", photo thumbnails when present), unknown stretches,
  "Show on map"; SAMAAN card marked Recommended with a thicker border; null route → message;
  synthetic badge. Map: three route styles distinguishable without colour (thin dashed, medium
  dotted, thick solid with casing), A/B pins, pulsing rings on the selected route's barriers
  (static under reduced motion), striped overlay on unknown stretches drawn on the real footpath
  geometry, non-selected routes dimmed, clicking a line selects its card. Barrier popups show
  photos when the layer carries `photo_urls`.
- Accessibility pass (plan 6.11): focus moves to a panel's heading on open and back to the opener
  on close, Escape closes panels, 48 px targets throughout, visible focus, contrast tokens in
  both themes, reduced motion respected, `lang` attributes, keyboard-only flow (Plan route →
  Riya's trip → select a card → Escape) verified, no horizontal scroll at 375 px.
- Verified live against the API in the desktop app's browser at 375 px and 800 px: Riya's trip
  returns the three routes; the SAMAAN card shows 821 m, 19 min, 99 % checked, a kerb ramp and
  time-weighted two-wheelers; no console errors. (Seeded overlay, illustrative only.)
- Tests: 98 passing (place extraction incl. same-name merging, search ranking and localisation).

### Decisions taken alone
- Search is substring-based over a local table (no external geocoder), so the demo works offline.
- The static demo-path layer switches off when a comparison loads (it looks like the SAMAAN
  line); it can be re-enabled in the legend.
- Planner and barrier list are mutually exclusive panels; on phones only one bottom sheet is open.

### Open issues
- The desktop breakpoint starts at 768 px, so an 800 px pane still shows the phone-style docked
  strip rather than three side-by-side cards; on a laptop screen the three-column layout applies.
- The route cards do not yet show per-barrier `confidence` or tags (available in the API).

### Human tasks (P6)
18. **Review the new Hindi strings** (15 min) in `web/src/i18n/hi.json` `route.*`: the agent
    was unsure about "सरल सुलभ" (naive accessible), "जोखिम सहनशीलता" (risk tolerance),
    "लचीला"/"सख़्त" (relaxed/strict), "कभी नहीं देखा" (never seen), "जाँचा गया"/"अनजाँचा"
    (checked/unchecked), "बच्चा-गाड़ी (प्रैम)", "छड़ी या वॉकर वाले बुज़ुर्ग", and the gendered
    "पार नहीं की जा सकती".
19. **Phone test** (10 min): open the app on an Android phone over the dev server (`make web`
    with `--host`, same Wi-Fi) and run Plan route → Riya's trip → swipe the three cards; note
    anything hard to tap or read.

---

## Phase P7 — Report, Validate, Missions (2026-10-24) — done

### Plan
Plan 6.8 + 6.9. Backend: users (no auth; display name + profile, trust score starting low),
`POST /reports` (photo + class + severity + GPS/heading; rate limit; reject when the photo is
> 50 m from the device; detector pre-screen when weights exist; geolocate + side-aware snap via
P4; duplicate detection against active barriers within 4 m; `pending`), the validation queue
(`GET /reports` near a point, excluding own), trust-weighted votes (`score = Σ vote × trust`,
verify/reject thresholds), verification creates or updates a barrier and recomputes states and
the routing context immediately, trust updates for reporter and voters, the fixed flow (a
`kind=fixed` report closes its target barrier on verification), `ml/export_active_learning.py`
(verified report photos → YOLO export with the prescreen box or a flagged weak box), and
missions (500 random OD pairs + anchor pairs routed in `samaan` and `shortest` mode; priority of
an unknown edge = routes using or detouring around it × length; top stretches as GeoJSON).
Web: Report sheet, Validate page, Missions page, user dialog, live refresh after resolution.

### What was built (backend)
- `api/services/reports.py` + `api/routers/reports.py`: `POST /users` (display name, profile,
  language, `team=true` for the demo crew → trust 0.8, others start at 0.3), `GET /users/{id}`;
  `POST /reports` (multipart: photo optional, class, severity, GPS, heading/pitch/HFOV,
  device GPS, `kind=barrier|fixed`, `target_barrier_id`): per-user rate limit (30/h), reject
  when the photo is > 50 m from the device (`gps_offset`), photo stored under
  `data/raw/reports/`, **prescreen** with the detector when `reports.prescreen.weights` exists
  (max score for the reported class + its box; skipped gracefully otherwise), **geolocate + side-
  aware snap** reusing P4 (prescreen box, else a centred low box; without a heading the reporter's
  own position is snapped), **duplicate detection** against active barriers of the same class
  within 4 m; status `pending`. `GET /reports` (near a point within 300 m, newest otherwise, own
  reports excluded, `my_vote`, distance), `GET /reports/{id}`. `POST /reports/{id}/votes`:
  one vote per user (changeable), `score = Σ weight × voter trust` (agree +1, disagree −1,
  unsure 0), verify at ≥ 0.6 / reject at ≤ −0.6, own report → 409, resolved → 400. **Resolution**
  creates a barrier (confidence from base 0.4 ± prescreen) or merges into the duplicate (severity
  averaged, confidence up, sources appended), or for `kind=fixed` closes the target barrier
  (`status=fixed`, `fixed_at`); then the shared state recompute runs and the API reloads the
  routing context, so the next `/route` call already reflects it. **Trust**: reporter +0.1 on
  verify / −0.15 on reject; voters +0.05 when with the consensus / −0.05 against (unsure neutral);
  clamped 0.05–1.0. All values in `config/pipeline.yaml` → `reports`.
- A real blocking barrier now makes an edge's state real (`state_synthetic=false`) even where
  the coverage is seeded.
- `pipeline/missions/compute.py` + `GET /missions` / `POST /missions/recompute` (`make missions`):
  500 random OD pairs (200–1500 m apart) plus anchor pairs, routed in `samaan` and `shortest`
  mode; an unknown edge scores one per route that uses it or detours around it; priority =
  count × length; scored edges merged into connected stretches; top 10 stored as `mission`
  rows with the nearest named road; `status` flips to `done` when none of a mission's edges is
  unknown any more. Real zone: 600 routes in ~5 s, 729 unknown edges scored, 272 stretches.
- `ml/export_active_learning.py` (`make export-active`): verified barrier reports with photos →
  YOLO dataset `data/labels/active_<date>/` using the prescreen box, else a centred weak box
  flagged `needs_box_review` in `manifest.csv`; never synthetic.
- Tests (105 passing): report → queue → votes → verified → barrier created, edge blocked, SAMAAN
  route re-planned around it, trust changes; duplicate merge; rejection lowers trust; abuse
  checks (GPS offset, unknown user/class/severity, fixed without target, rate limit 30 → 429);
  fixed flow closes the barrier and clears the edge with a single team vote; missions ranking
  and done-flip; active-learning export with weak boxes.

### What was built (web)
- Identity: "Who are you?" dialog (name, profile, **"I am on the SAMAAN team"** checkbox → trusted
  user who verifies alone), stored locally; a chip shows name and trust level.
- **Report sheet**: floating "Report a barrier" button on the map and a button in the planner;
  GPS + compass captured on open, camera preview with file fallback, class tiles (8 detector
  classes, then the report-only ones), severity tiles 1–5 with a pictogram and word, note; posts
  multipart; shows the prescreen verdict ("Our detector also sees …" / "not recognised"),
  duplicate hint, and the error reasons (rate limit, > 50 m from device, invalid). Pending reports
  appear as hollow markers until verified. **"Report as fixed"** in barrier popups and on route
  cards opens the sheet with class/severity locked and photo required.
- **Validate page** (`#/validate`): nearest pending reports within 300 m (newest anywhere when
  GPS is unavailable, with a note), one card at a time: photo, class, severity, note, distance,
  time, mini-map, Agree / Disagree / Unsure (keys 1/2/3), result line; when a vote resolves the
  report the page says "Verified — the map and routes were updated", reloads the layers and
  re-runs the last route comparison.
- **Missions page** (`#/missions`): ranked list (street, length, "needed by N routes",
  open/done), "Show on map" highlights the stretch, "Walk this" opens capture with the session
  id `mission-<id>`, Recompute.
- Verified live on a scratch DB: a steps report placed on Riya's SAMAAN route (pending, hollow
  marker) → one Agree from a team user on the Validate page → "Verified" message → the API's
  SAMAAN route moved from 821 m / 41 edges to 830 m / 42 edges avoiding that edge, and the
  shortest route now lists a third impassable steps barrier. No console errors. Camera and GPS
  cannot run in the desktop pane; the street test is a human task.

### Decisions taken alone
- Verify threshold 0.6 with new users at 0.3 and team users at 0.8: two strangers or one team
  member verify a report; the same symmetric threshold rejects. Plan's fallback ("simple
  majority") was not needed.
- Reports without a heading snap the reporter's own position; with a heading they go through the
  P4 locate + snap using the prescreen box or a centred low box.
- Report photos are stored under `data/raw/reports/` (gitignored) with attribution "citizen
  report by user N".
- Missions name a stretch after the nearest *named* road; OSM names only four streets here, so
  most missions read "Bhartendu Harish Chandra Marg". Human correction of street names in OSM
  would fix this at the source.

### Open issues
- The Validate card's status line shows the pre-vote snapshot until "Next report" (cosmetic).
- No marker drag on the report sheet: the barrier position equals the phone position at photo
  time; the heading-based offset handles the common "pointing at it from the footpath" case.
- Prescreen needs the trained weights; until then every report says "not recognised".
- Trust is per device (localStorage), not authenticated; acceptable for the hackathon, noted
  for the pitch's honesty slide.

### Human tasks (P7)
20. **Street test of the citizen loop** (30 min, two phones, after HTTPS is set up): phone A
    (new user) reports a real obstacle with a photo; phone B (team user, tick "I am on the
    SAMAAN team") opens Validate, votes Agree, confirms the route re-plans; then phone B reports
    it as fixed and phone A validates. Note anything confusing in this file.
21. **Review Hindi strings** (10 min) in `web/src/i18n/hi.json` sections `user`, `report`,
    `validate`, `missions`: the agent flagged "पार नहीं हो सकती", "ठीक हो गई, रिपोर्ट करें",
    "भरोसा … नया/नियमित/भरोसेमंद", "मिशन", "इस पर चलें", "पुनर्गणना करें", "पक्का नहीं",
    "फुट ओवरब्रिज, केवल सीढ़ियाँ", "हमारा डिटेक्टर भी देखता है".

---

## Phase P8 — Reach Gap (2026-10-24) — done

### Plan
Plan 6.7: single-source Dijkstra from an anchor with a time cutoff (default 10 min) using the
P5 cost model (walker baseline in naive mode, target profile in `samaan` mode with the chosen
risk); metric = total reachable footpath length in km counting partial edges; concave hull of
the reached edges for display; Reach Gap = walker − target, plus ratio; greedy fix ranking over
active barriers inside the walker's reach (apply the best, recompute, repeat up to 5) with cost
ranges from `config/fix_costs.yaml` labelled estimate and "reach gained per ₹ lakh" when a cost
exists; `GET /reach` with a `fixed=` simulation parameter; `GET /reach/anchors`. Web: Reach Gap
page with the headline, two blobs, top-5 fixes and simulate-fix animation. Tests on toy graphs.

### What was built (backend)
- `api/services/reach.py`: `reach()` = Dijkstra with cutoff on the P5 cost model, partial edges
  counted by the fraction that fits in the remaining time, result = reachable footpath length;
  concave hull (`shapely.concave_hull`, ratio 0.35, 3 m buffer) of the reached edge points in
  WGS84 for the blob; `fix_candidates()` = active barriers on edges inside the walker's reach
  that cost the target profile something; `rank_fixes()` = greedy up to 5 (apply best, recompute,
  repeat) with cost ranges from `config/fix_costs.yaml` and "km gained per ₹ lakh" when a cost
  exists (all costs are still `TODO: estimate`, so that column is null); `reach_gap()` bundles
  walker (naive mode, no unknown penalty) vs target profile (samaan mode, chosen risk), gap, ratio,
  fixes and an optional `fixed=` simulation.
- `GET /reach?anchor&profile&cutoff_min&risk&fixed=ids` and `GET /reach/anchors`.
- Tests (110 passing): partial-edge arithmetic with known answers, blocked graph → zero reach,
  greedy order and cumulative totals, simulation restores the walker's reach, candidates only
  inside walker reach and only costly ones, hull validity, API contract and error codes.

### Illustrative numbers (real graph, SEEDED overlay, 10 min, balanced risk — not an evaluation)
| anchor | walker | wheelchair | gap | ratio | top fix gain |
|---|---|---|---|---|---|
| Karkarduma metro | 47.0 km | 16.3 km | 30.7 km | 0.35 | +0.24 km (steps, sev 4) |
| hospital (OSM) | 36.6 km | 14.5 km | 22.0 km | 0.40 | +0.16 km (open drain, sev 5) |
Response time ≈ 0.5–0.9 s per anchor including the ranking. Honest reading: with the seed, the
gap is driven mostly by the slower profile speed and the unknown-footpath multiplier, not by the
33 seeded barriers, so each fix gains little. Real coverage and real detections will change both
the gap and the ranking; `eval/reach_eval.py` (P10) will record the real numbers.

### What was built (web)
- `#/reach` page ("Reach Gap" in the nav): anchor select (from `/reach/anchors`), profile radios
  (wheelchair, elderly with walking aid, pram; the walker is the fixed baseline), 5/10/15-minute
  time budget, risk radios; **headline** tiles in large type ("Walker reaches X km · Wheelchair
  user reaches Y km · Reach Gap Z km (ratio %)") with a one-sentence explanation of the measure
  and a screen-reader live summary; **two blobs** on the map (walker light blue solid outline,
  target purple dashed) plus the anchor star and numbered fix pins; **the city's to-do list**
  (rank, name, severity word, +gain and cumulative, cost range or "not estimated yet", gain per
  lakh, Show flies to the pin) with a **"Simulate fixing: …" checkbox** per row, "Simulate all" /
  "Clear"; simulated reach drawn as a green dotted blob with a 600 ms grow animation (off under
  reduced motion), headline gains "With these fixes: … km (gap … km)". Synthetic badge and hint.
  Focus management, Escape, 48 px targets, high-contrast tokens for the blobs, en/hi strings.
- Fixed during live verification: the anchors request had an "already sent" guard that React
  StrictMode's double effect run turned into a permanent "Loading places…" (the first request is
  aborted on the simulated unmount); the guard was removed. Also fixed by the agent: the desktop
  nav grid collapsing to one column with five links.
- Verified live against the API: headline "A wheelchair user reaches 35 % of what a walker
  reaches", blobs, star, pins, five fix rows, simulate-fix line. No new console errors.

### Decisions taken alone
- Walker baseline uses `naive_accessible` mode (no unknown penalty): "what a map shows a
  walker"; the target profile uses `samaan` mode with the chosen risk, so the gap includes the
  honesty penalty for unseen footpaths. Both are stated in the UI's explanation sentence.
- Reach counts partial edges by remaining time; the hull is only a display aid (plan: length, not
  area, is the metric).
- Fix candidates are capped at the 60 most severe inside the walker's reach to bound the greedy
  search (each round is one Dijkstra per candidate).

### Open issues
- Gains below 50 m show as "+0.0 km" at one decimal; show metres below 1 km (web polish, P10).
- With the seed, the five fixes add only ~0.5 km in total; the honest pitch line is the ratio and
  the gap, and the fix list becomes meaningful with real barriers.
- `fix_costs.yaml` is all `TODO: estimate`, so "gain per ₹ lakh" is empty everywhere.

### Human tasks (P8)
22. **Rough fix-cost ranges** (30 min): fill `config/fix_costs.yaml` `min`/`max` in ₹ lakh per
    class with a `source` note (CPWD/PWD schedule of rates, a contractor's quote, or "team
    estimate"). The UI labels every figure "(estimate)".
23. **Pick the demo anchor and cutoff** (5 min): run the Reach Gap page for the metro at 5/10/15
    minutes and note which cutoff gives the clearest story; put it in `docs/demo_script.md`.
24. **Review Hindi strings** (10 min) in `web/src/i18n/hi.json` `reach.*`: "पहुँच अंतर",
    "प्रैम चलाने वाले", "शहर की करने-योग्य सूची", "एंकर".

---

## Phase P9 — Wheels as sensors (2026-10-24) — done

### Plan
Plan 6.10 (phone only; 9b ESP32 is cut first by the plan's order): rides with accelerometer
(~50 Hz) + GPS (1 Hz) uploaded in 10 s batches; processing = pick the gravity axis, high-pass by
subtracting a 1 s rolling mean, 1 s windows with RMS and peak, GPS interpolation + heading per
window, map-match to the nearest footpath edge within 10 m whose direction agrees with the GPS
heading; per edge roughness = median window RMS over traversals; a smooth traversal covering
≥ 80 % of an edge = **verified by wheels** → `Coverage(source=wheel)` → `clear` via the shared
state recompute; window peak above the jolt threshold → `suspected` barrier (not routed on) with a
"photograph this" mission; thresholds in `config/pipeline.yaml` marked TODO: calibrate;
`eval/ride_calibration.py` picks thresholds from labelled calibration rides (human task) and
refuses synthetic rides; a synthetic demo ride generator (flagged synthetic) for the pitch's
"replay a ride" step. Web: Ride page (Start/Stop, DeviceMotion, Wake Lock, batches, summary),
wheels layer, jolt markers, replay demo.

### What was built (backend)
- `pipeline/ride/process.py`: gravity axis = the axis with the largest mean magnitude (works for
  any mounting); high-pass = sample minus a centred 1 s rolling mean; 1 s windows with RMS and
  peak; GPS fixes interpolated to the window centre (position, heading, speed, accuracy);
  map-matching to the nearest edge within 10 m whose direction agrees within 60° (either way,
  undirected graph), skipping stopped windows and poor GPS; consecutive windows on one edge form a
  traversal; **verified by wheels** when the traversal spans ≥ 80 % of the edge and every window
  RMS is below the smooth threshold → `Coverage(source=wheel)` → `clear` through the shared state
  recompute (`observed_by=wheel`); `EdgeRideStat` keeps the last 500 window RMS values, the
  median as `roughness_index`, traversal/window counts and jolt events; a window peak above the
  jolt threshold creates a **`suspected` barrier** (class from config, confidence 0.3, tag `jolt`)
  or attaches to a barrier within 4 m; suspected barriers never enter routing.
- API: `POST /rides`, `POST /rides/{id}/samples` (10 s batches), `POST /rides/{id}/end` (process +
  state recompute + routing reload), `GET /rides/{id}`, `POST /rides/replay-demo` (a synthetic
  ride along a contiguous unknown stretch next to Riya's route, flagged synthetic on the ride,
  samples, coverage, stats and barrier), `GET /layers/wheels` (edges with roughness and the
  verified flag + jolt points).
- `eval/ride_calibration.py` (`make ride-calibration`): labelled windows (smooth / broken / kerb
  from `data/ground_truth/ride_calibration.csv`) → suggested thresholds (midpoint between the
  smooth 95th and broken 5th RMS percentiles; between the non-kerb 99th and kerb 10th peak
  percentiles), separability flags, histogram PNG, `eval/results/ride_calibration.*`; refuses
  synthetic rides. Thresholds in `config/pipeline.yaml` stay `TODO: calibrate` until then.
- Tests (117 passing): gravity axis + high-pass, windows/heading/speed, direction-aware matching
  rejects a nearer perpendicular edge, stopped windows ignored, coverage fraction, full API ride
  in batches flipping an unknown edge to clear with `observed_by=wheel`, rough ride does not verify
  and its jolt becomes a suspected barrier outside routing, synthetic replay flagged throughout,
  generator shape, threshold picking.
- Real zone (scratch copy): the demo replay processes a 173 s synthetic ride in ~2 s, verifies 3
  edges (all flipped unknown → clear) and raises 1 suspected barrier. 9b (ESP32) not built, per the
  plan's cut order.

### What was built (web)
- `#/ride` page: mounting instructions, user chip, 64 px **Start ride** (requests motion
  permission on iOS inside the tap, creates the ride, starts `devicemotion` at the event rate and
  high-accuracy GPS at ~1 Hz, keeps the screen awake with the Wake Lock API), live counters
  (duration, samples, batches sent/pending, speed, 1 s RMS, "last jolt N s ago"), 10 s batches
  persisted in IndexedDB before upload with backoff and offline pause, **Stop** → flush → end →
  summary ("You verified N footpath segments by wheels · M suspected barriers found", windows
  matched, segments traversed, roughness list, synthetic badge) with **Show on map**; a secondary
  **Replay demo ride** button, clearly badged synthetic, for the pitch.
- Map: "Wheels" layer (off by default; Show on map turns it on and fits): verified-by-wheels
  edges as a green/white rail pattern, traversed-but-not-verified edges as a thin brown line,
  jolts as hollow orange "!" markers; popups with roughness, traversals, last traversed; the jolt
  popup's **Photograph this** opens the report sheet prefilled with the class and the jolt
  position (device GPS still checked). Legend rows in words. Missions page gained a second list
  "Photograph these jolts".
- Verified live against the API on a scratch DB: Replay demo → "You verified 3 footpath segments
  by wheels · 1 suspected barrier found" → Show on map draws the rail pattern on the three edges
  (previously dashed grey = unknown, now solid = clear), the brown segment and the "!" marker. No
  console errors. A real ride with motion sensors cannot run in the desktop pane (human task).

### Decisions taken alone
- The gravity axis is detected per ride (largest mean magnitude), so the phone can be mounted in
  any orientation; the plan's "vertical acceleration" is that axis.
- High-pass = 1 s rolling-mean subtraction (no scipy dependency); calibration decides thresholds.
- Suspected barriers (jolts) are visible on the map and in Missions but never enter routing or
  the Reach Gap until a photo report verifies them.
- The demo replay runs along a contiguous unknown stretch next to Riya's route so the visible
  flip exists on the seeded zone; the ride, its samples, coverage, stats and barrier are all
  flagged synthetic.
- ESP32 (9b) skipped, per the plan's cut order.

### Open issues
- Thresholds (`smooth_rms_threshold_m_s2` 1.2, `jolt_peak_threshold_m_s2` 7.0) are placeholders
  until calibration rides exist; the client-side jolt hint uses a fixed 6 m/s².
- Map-matching is per window with no sequence smoothing; at junctions a window can attach to a
  crossing instead of the sidewalk. Fine for coverage, revisit if jolts land on wrong edges.
- Speed comes from GPS fix spacing (1 Hz), so `min_speed` filtering is coarse.

### Human tasks (P9)
25. **Borrow a wheelchair (or use a trolley/pram)** and do **calibration rides** (45 min, two
    people): mount the phone, Start ride, ride ~40 s on a known smooth stretch, ~30 s on a known
    broken stretch, then over a known kerb 3 times, noting the ride timer at each segment start
    and end. Stop. Fill `data/ground_truth/ride_calibration.csv` (see `.example`), run
    `make ride-calibration`, copy the suggested thresholds into `config/pipeline.yaml` → `ride`,
    commit `eval/results/ride_calibration.*`.
26. **One real ride along the demo route** (15 min): Start ride at the metro, ride Riya's route,
    Stop, check the summary and the Wheels layer; note any edge that did not verify.
27. **Review Hindi strings** (10 min) in `web/src/i18n/hi.json` `ride.*`, `wheels.*`: "झटका"
    (jolt), "ऊबड़-खाबड़पन" (roughness index), "पहियों से सत्यापित", layer name "पहिए",
    "मिलान हुए विंडो".

---

## Pivot after the mentoring round (2026-10-24)

Mentor feedback, verbatim in spirit:
1. How is the latest data collected, in real time?
2. Three routes for one trip is confusing: two routes, each with a confidence score.
3. A disabled person should not have to "explore" a campus first; the system must work anywhere.
4. Three target users, each with their own mode: mobility (route planner), dyslexic/autistic
   (Explore mode: camera view with big arrows and pictograms), blind (voice-driven app).
5. Phone-first UI in the style of modern iOS navigation apps (black turn banner, white cards,
   blue #1561F1 on off-white #FAFAF9, bottom sheet with arrival · min · km, statistics cards).

Decisions:
- Zone moved to the Manipal University Jaipur campus (richly mapped footways; the team can
  capture real imagery on site during the hackathon).
- `/route` returns **two** routes by default, `standard` (what a normal map does) and `samaan`,
  each with a **confidence score** from verified coverage, image age, barrier verification and
  unknown share, plus "segments without recent imagery". The third mode stays available for
  evaluation only (`modes=all`).
- **Turn-by-turn steps** on every route (direction, distance, street, warnings) feed the text
  banner (mobility), the arrows (Explore) and speech (Listen).
- Two new profiles: `blind_low_vision` and `cognitive`; the UI exposes three modes: Move,
  Explore, Listen.
- Real-time data answer: the app itself is the sensor. Navigation can contribute photos every
  N metres (consent toggle), rides verify footpaths, reports update within a minute, temporary
  barriers expire, and every route shows how fresh its evidence is. Any area can be built from
  OSM in under a minute, degrading honestly to "unknown" where nothing has been seen.
- Detector: zero-shot pretrained model for vehicles first; India-trained model when labels exist.

### Pivot work done (backend)
- `/route` now returns `standard` + `samaan` by default (`modes=all` adds `naive_accessible` for
  evaluation). Every route carries `confidence {score, label, factors}` (weights in
  `profiles.yaml` → `route_confidence`: verified share 0.45, imagery freshness 0.25 with a
  90-day fresh / 365-day stale ramp, barrier verification 0.15, known share 0.15),
  `segments_total`, `segments_no_recent_imagery(_pct)`, and **turn-by-turn `steps`** (depart /
  turns by heading change ≥ 15° / cross with signal info / arrive; street names from OSM; warnings
  = barriers on the following edges with the impassable flag for the chosen profile; legs under
  6 m such as corner links never create turns; instructions in English and Hindi).
- Profiles: `cognitive` (Explore mode: fewer and signalised crossings, calm penalties) and
  `blind_low_vision` (Listen mode: unsignalised crossings as a last resort, open drains
  impassable, carriageway walking strongly penalised), with descriptions and a `profile_modes`
  map; `GET /profiles` for the UI. All values team_estimate / TODO: cite.
- Temporary barriers expire after `temporary_expiry_days` (14, taxonomy.yaml) when not seen again;
  runs in `make coverage` and after every upload recompute.
- Zero-shot detector: `config/zero_shot.yaml` maps COCO classes (motorcycle, bicycle, car, truck,
  bus → parked_vehicle; hydrant, bench, planter, signs → fixed_obstacle) onto the taxonomy;
  `make infer-zero-shot` runs the pretrained YOLO11n with that map. On the 18 real Mapillary
  images of the campus (2017): 3 detections → 2 real `parked_vehicle` barriers after side-aware
  snapping. Limits are written in the config: it cannot see steps, drains, kerbs or surfaces, and
  a moving vehicle looks like a parked one in a single frame.
- **Any area on demand** (`POST /zones/rebuild {name, bbox, anchors}` → background build into
  `data/processed/zone_<name>.sqlite`, `GET /zones/status`, `POST /zones/reset`): the whole app
  follows the new area via `active_zone.json`. Live: central Jaipur (1.3 km box) built in 6 s,
  2973 edges; routes came back with honest "low confidence, 100 % unknown, 0 barriers". This is
  the answer to "it must work anywhere": no exploration phase, just honesty about what is unseen.
- **Within a minute**: a reporter with trust ≥ 0.8 (team users) and a photo is verified on
  submission; the barrier, states and routing context update before the response returns.
  Reports without a photo, or from new users, still go through validation.
- Tests: 122 passing (steps on a toy corner + crossing, confidence fresh vs stale, two-route
  contract, profiles endpoint, zone override + rebuild validation, auto-verify).

### Pivot work done (web, phone-first)
- New shell in the reference style (off-white, white cards, blue #1561F1, black turn banner,
  system font): status strip, bottom tab bar Home / Navigate / Contribute / More; the old pages
  (Validate, Missions, Reach Gap, Ride, Capture, Statistics, Settings) live under More.
- **Home**: greeting, "Where to?" search, Pick on map, origin = GPS, the three mode cards Move /
  Explore / Listen (choosing a mode selects the matching profile and vice versa), "Try the demo
  trip".
- **Route choice (Move)**: two cards, Standard vs SAMAAN (Recommended), minutes, km, a confidence
  ring with the label, barriers (impassable count), "x % checked · n segments without recent
  imagery"; tap to preview; Start.
- **Navigation**: black banner (arrow glyph, distance, instruction, street), warning chips,
  map following the position with a blue dot, round buttons (voice, report, end), bottom sheet
  arrival · min · m with a progress bar; "Simulate walk" (1 m/s, ×5/×20) when GPS is unavailable,
  clearly labelled; arrival summary; optional photo contribution every 10 m from real GPS only.
- **Explore**: full-screen camera (map fallback), one big arrow rotated to the next step, a step
  pictogram, ≤ 4 words, big distance, calm palette, Simplify toggle.
- **Listen**: one giant button, speech synthesis in hi-IN / en-IN, speech recognition for the
  destination with read-back and "yes" confirmation, commands repeat / where am I / stop, every
  step and warning spoken, confidence announced once; text fallback when speech is unavailable.
- Contribute tab (consent toggle + links), Statistics 2×2, Settings (profile, risk, language,
  contrast, user). 734 en/hi keys with parity.
- Verified live against the API at 390×844: Home → demo trip → two cards (88 % / 91 % high) →
  Start → banner "70 m Turn right" → simulated walk counts down and the dot moves; no console
  errors. Not verifiable in the desktop pane: real GPS, compass arrow, camera, microphone.
- Hindi to review: mode names are transliterations (मूव / एक्सप्लोर / लिसन), "भरोसा"
  (confidence), "नकली चाल" (simulated walk), "हल्का/तीखा बाएँ-दाएँ", profile names.

## Second mentor round — six gaps (2026-10-25)

The user's list after testing the iOS build: (1) live location on the map, (2) a blind traveller must
be able to run the whole app by voice, (3) dated UI and bugs, (4) a first-run "who are you" screen
that opens the right experience per disability, (5) a proper demo mode with real campus data,
(6) no Report button anywhere + CSR partners / coupons in Contribute.

### What was built (web)
- **Live location (1).** GPS starts on launch (`useSensors().enableLocation`, no motion prompt), the
  blue dot and accuracy halo show on every map screen, Home's From row reads "My location · ±N m"
  with a pulsing dot, a locate button recentres, the map auto-centres once when the first fix is
  inside the zone. Navigation still uses the same watch.
- **Voice-only (2).** Listen is now a hands-free conversation: after every prompt SAMAAN listens
  again by itself (stops after two silent rounds, "tap anywhere when you want to talk"); single tap
  anywhere = talk, double tap = repeat. New spoken commands: help, report (→ "what is blocking the
  way?" → class parsed from speech → yes → `POST /reports` without a photo at the GPS fix), home,
  "I can't see". Hindi commands now match (the old `\b` regexes never matched Devanagari). The
  welcome screen speaks a greeting and, in the native app, listens for "I can't see"; a double tap
  anywhere picks the blind path. No Vapi / cloud receptionist: no key was available; on-device
  Apple Speech + speechSynthesis is used (human task 29 if a cloud agent is wanted).
- **UI pass (3).** Onboarding hero, dark immersive Listen (orb with pulse rings, transcript
  bubbles), grouped More with icon rows, Contribute hero card, SVG icon set (`icons.tsx`) instead
  of emoji, quieter "demo seed" badge, Demo page tiles.
- **First-run screen (4).** `#/welcome` (shown until `samaan.onboarded` + a user exist): language,
  "How do you move?" (wheelchair / walking aid / pram → Move; autistic or dyslexic → Explore; blind
  or low vision → Listen; walking → Move), optional name, Continue → `POST /users` (falls back to a
  local identity offline). Blind path: greeting spoken, double tap / "I can't see" / big black
  button → Listen with a spoken greeting and the mic open. A returning Listen user lands in Listen.
  Settings → "Change how I move" reopens it.
- **Demo mode (5).** More → Demo: one-tap demo trip per mode, honest counters from
  `GET /demo/status` (real vs synthetic photos, real coverage %, real vs seeded barriers, reports,
  rides, users), Replay demo ride, Reset demo data (two-tap confirm → `POST /demo/reset`), and the
  photo-collection brief. `docs/demo_script.md` rewritten for MUJ with the teammate brief.
- **Report everywhere + CSR (6).** Report pill on Home/Navigate map, Report row in the Home sheet,
  Report in every mode (Move/Explore buttons, Listen voice + button), Contribute hero button.
  Contribute shows a points ledger (`rewards.ts`, local: photo +2, report +25, vote +5, ride +40,
  trip +10) with progress to the next coupon and a CSR partner catalogue (Campus Café, Metro Smart
  Card, City Pharmacy, Jaipur Bookstore, Wheelchair taxi) with Redeem. Labelled as a pilot
  catalogue with placeholder names; points live on the phone.
- 889 en/hi keys with parity (was 734).

### What was built (backend)
- `api/routers/demo.py`: `GET /demo/status`, `POST /demo/reset` (see the session report in the
  commit message / tests `tests/test_demo_api.py`), `make demo-reset`.

### Decisions taken alone
- Points and partner names are product placeholders, kept out of the server and flagged in the UI
  ("pilot catalogue"); no partner is claimed as signed.
- Voice reports have no photo and severity 3; they go through the normal validation loop.
- Onboarding creates a server user without the team flag; team members tick it in Settings.
- The welcome mic listens only inside the native app (browsers block speech without a gesture).

### Human tasks
28. **Walk the campus with Capture** (45 min, 2–3 phones): the brief is in `docs/demo_script.md`
    ("Collecting real campus photos"). Then `make infer-zero-shot && make geolocate` and
    `POST /route/reload`.
29. **Cloud voice agent (optional)**: if you want Vapi/Retell instead of on-device speech, get a key;
    the swap point is `web/src/speech.ts` (`speak`, `createRecognizer`) and `ListenScreen.handleText`.
30. **Review Hindi** for `welcome.*`, `listen.say.*`, `rewards.*`, `demoPage.*` (10 min).
31. **Rebuild the iPhone app** after any tunnel restart: `make ios-sync API_URL=<url>` then the
    xcodebuild/devicectl steps in `docs/IOS_APP.md`.
32. **CSR partners**: replace the placeholder catalogue in `web/src/rewards.ts` + `rewards.partners.*`
    strings once a real partner agrees; decide whether points move to the server (`User` table).

## Live voice agent for blind travellers — Vapi (2026-10-25)

The user supplied a Vapi key ("the app is not interacting with blind people"). It is a *public*
key (Vapi's `/assistant` endpoint answers 401 to it), so it is used where public keys belong: in
the phone's web SDK. It is never committed; the API reads it from `VAPI_PUBLIC_KEY` and hands it to
the app through `GET /voice/config`, so changing the key needs no rebuild.

### What was built
- `api/routers/voice.py`: `GET /voice/config` (enabled + public key + tool names) and
  `POST /voice/tools`, the webhook Vapi calls for the assistant's tools: `find_place` (→ `/search`
  logic, returns the top match with lat/lon), `report_barrier` (creates a photo-less report at the
  traveller's location, severity 3; falls back to a "Voice traveller" user), and acknowledgements
  for `start_navigation` / `stop_navigation` / `repeat_step` / `where_am_i`, which the app acts on
  itself. Always answers 200 with `results[]` as Vapi requires. 6 tests in `tests/test_voice_api.py`.
- `web/src/vapi.ts`: builds a transient assistant (GPT-4o-mini, Deepgram nova-2 `en`/`hi`, Azure
  voices en-IN Neerja / hi-IN Swara, tools pointing at `<API_URL>/voice/tools`, a system prompt that
  forbids inventing places or directions), opens the call with `@vapi-ai/web`, and exposes `say`
  (assistant voices navigation steps), `addContext` (system messages with the traveller's location
  every 20 s and the current step) and tool-call events.
- Listen screen: when `/voice/config` is enabled, the orb opens a live call instead of the on-device
  recogniser ("Live voice agent" chip, "Tap to talk to SAMAAN", "SAMAAN is speaking…", End call).
  The blind onboarding path starts the call automatically. Tool calls from the assistant start,
  stop and repeat navigation in the app; navigation announcements are spoken by the assistant's
  voice (speechSynthesis muted during a call). If the call fails, the screen falls back to
  on-device speech with the error shown.

### Run
```
VAPI_PUBLIC_KEY=<public key> make api-lan      # plus the cloudflared tunnel
```
The webhook must be reachable from Vapi's servers: through the tunnel URL baked into the app
(`make ios-sync API_URL=<tunnel>`); on a LAN-only API the tools fail and the assistant says so.

### Decisions taken alone
- No private key is needed or stored; the assistant is transient (no dashboard setup).
- Webhook is unauthenticated for the hackathon (it can only search and file pending reports).
- Reports filed by voice use the traveller's user id when the app passed one, else the shared
  "Voice traveller" user (trust 0.3, pending until validated).

### Human tasks
33. **Try the live call on the iPhone** (5 min): Listen → tap the orb → say "library" → "yes" →
    walk / simulate → "where am I" → "report" → "parked scooter" → "goodbye". Check the API log for
    `POST /voice/tools`. If the first call fails with a microphone error, allow the mic in
    iOS Settings → SAMAAN.
34. **Vapi dashboard**: confirm the public key's allowed origins (if restricted, add
    `capacitor://localhost` and `http://localhost`) and watch the call logs during the demo; add
    credit if the free tier runs out.

## Phase P10 — Eval, demo, polish
_Rescoped after the pivot; starts after the pivot work._
