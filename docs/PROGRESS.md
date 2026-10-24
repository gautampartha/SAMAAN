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

## Phase P2 — Ingest & capture
_Not started. Waiting for "go"._
