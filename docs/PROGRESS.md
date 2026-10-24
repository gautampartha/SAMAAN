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

## Phase P1 — Footpath graph
_Not started. Waiting for "go"._
