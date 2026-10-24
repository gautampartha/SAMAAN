# SAMAAN — Walk for All

Accessible walking routes from street imagery, built for Indian footpaths.
Hackathon problem statement **SC-02** (Track 05 · Smart Cities). Demo zone: Karkarduma metro, East Delhi.

SAMAAN finds barriers on footpaths from street images, puts each one on the correct footpath
segment and side of the road, routes people around them, and is honest about which footpaths
have never been seen. For the city it measures the **Reach Gap** between a walker and a
wheelchair user from a metro station, and ranks the fixes that close it fastest.

The full build plan is `SAMAAN_PLAN.md`; progress, how-to-run and human tasks are in
[docs/PROGRESS.md](docs/PROGRESS.md).

## Quick start (P0)

```bash
make setup     # Python 3.11 venv via uv, installs deps
make seed      # downloads OSM for the zone (cached), builds the graph, seeds SYNTHETIC barriers
make test      # pytest (offline, uses a toy grid graph)
make api       # FastAPI on http://127.0.0.1:8000  (OpenAPI docs at /docs)
make web-install && make web   # React PWA on http://127.0.0.1:5173
```

Every row produced by `make seed` is flagged `synthetic=true` and must never appear in
evaluation outputs (`SAMAAN_PLAN.md` section 11, rule 2).

## Layout

```
config/     zone.yaml, profiles.yaml, taxonomy.yaml, fix_costs.yaml, pipeline.yaml  (all thresholds live here)
common/     config loader, CRS (EPSG:32643), geometry helpers, segment state
pipeline/   graph/ (OSM download + graph), seed/ (synthetic data); detect/ geolocate/ coverage/ follow in later phases
api/        FastAPI + SQLModel (SQLite), GeoJSON layer endpoints
web/        React + Vite + MapLibre PWA, Hindi/English, accessible UI
ml/ eval/   training, evaluation and the scripts that produce every pitch number (later phases)
tests/      geometry, CRS, state, seed invariants, API
docs/       PROGRESS.md, labelling_guide.md, demo_script.md
data/       raw/ (gitignored), processed/ (SQLite, gitignored), ground_truth/
```

## Data and licences

- Map data © OpenStreetMap contributors, ODbL 1.0. Fetched from the OSM API for the zone bbox.
- Basemap tiles: OpenFreeMap (© OpenMapTiles, data from OpenStreetMap).
- Imagery (from P2): Mapillary (CC BY-SA, attribution stored per image) and our own photos. **No Google Street View.**
- Code: AGPL-3.0 (required by Ultralytics YOLO, which the detector uses from P3).

## Acknowledgements

Built on the ideas and taxonomy of [Project Sidewalk](https://github.com/ProjectSidewalk) (University of
Washington). Related prior work: AccessMap, the Government of India Sugamya Bharat app, and research
on smartphone-accelerometer sidewalk roughness. SAMAAN's contribution is the combination for Indian
footpaths, honest coverage, and the Reach Gap.
