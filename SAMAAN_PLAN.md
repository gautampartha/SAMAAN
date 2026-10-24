# SAMAAN — Walk for All
### Build plan (problem statement SC-02: Accessible Walking Routes from Street Imagery)

> Hand this file to the coding agent. It is the single source of truth for scope, architecture and phases.
> Numbers marked **[MEASURE]** must come from our own scripts — never invent them.

---

## 1. The idea in one paragraph

SAMAAN finds barriers on Indian footpaths from street images, puts each one on the **correct footpath segment and side of the road**, and routes people around them. It tells users how much of a route has actually been checked: it never calls an unseen footpath "safe". For the city, it measures the **Reach Gap**, meaning how much of a neighbourhood a wheelchair user can reach from a metro station compared with a walker, and ranks the fixes that would close that gap fastest. Citizens report barriers the model missed, other users validate those reports, and a phone mounted on a wheelchair passively confirms which footpaths are smooth ("wheels as sensors").

**Pitch line:** *"From Karkarduma metro, a walker reaches X km of footpath in 10 minutes. A wheelchair user reaches Y. Fixing these 3 barriers doubles that."* (X, Y = **[MEASURE]**)

**Why judges should care:** every component maps to a stated key challenge of SC-02:
| SC-02 key challenge | SAMAAN component |
|---|---|
| Detecting small barriers in varied street images | India-specific detector + domain-gap experiment (Phase 3) |
| Matching detections to the correct map segments | Side-aware geolocation and snapping on synthesised footpaths (Phases 1, 4) |
| Planning routes on footpath networks with barrier costs | Profile routing that knows what's unknown + Reach Gap (Phases 5, 8) |

---

## 2. What we take from Project Sidewalk (and what we change for India)

Project Sidewalk (University of Washington, github.com/ProjectSidewalk) is the reference named in the problem statement. We reuse its **ideas, taxonomy and open code**. We do **not** use Google Street View imagery: its terms restrict downloading it for training, so we use Mapillary (open licence) and our own photos.

| Project Sidewalk concept | What it is there | How SAMAAN uses it | What we change for India |
|---|---|---|---|
| **Label taxonomy** (CurbRamp, NoCurbRamp, Obstacle, SurfaceProblem, NoSidewalk, Crosswalk, Signal) | Standard accessibility label types | We keep their category names so results can be compared directly | We add India-only classes: vendor encroachment, open drain, bike-barrier chicane, high kerb, footpath end (Section 3) |
| **Severity rating 1–5** | Each label has a severity | Same 1–5 scale on every detection and report | Profile-specific pass/fail thresholds use severity |
| **Tags** (e.g. "parked car", "pole", "narrow", "cracks") | Sub-descriptors on labels | Tags refine our Obstacle and Surface classes | India tags: two-wheeler, auto-rickshaw, cattle, transformer box, construction debris |
| **Explore** (crowd labelling on panoramas) | Volunteers label street imagery | Our team labels photo walks; citizens use **Report** for anything the model missed | Phone photos + GPS + compass heading instead of panoramas |
| **Validate** (users vote agree/disagree on others' labels) | Quality control by crowd | Our **validation queue** for citizen reports, weighted by a trust score | Hindi/English, one-thumb UI |
| **Missions** (assigned streets to audit) | Gamified coverage | **Targeted missions**: unknown segments ranked by how many routes need them | Missions driven by demand and Reach Gap impact, not random streets |
| **AI tagger / validator** (`sidewalk-tagger-ai`, `sidewalk-validator-ai`) | Models that suggest tags and pre-validate labels | Our detector **pre-screens** every report photo and suggests tags | Trained on Indian images |
| **Label lat/lng estimation** (`label-latlng-estimation`) | Estimates a label's real-world position from imagery | Starting point for our geolocation | Extended with **side-of-road assignment** and snapping to footpaths we synthesise ourselves (Indian OSM rarely maps footpaths) |
| **RampNet** (auto-generated training data from government location data + kerb ramp model) | Bootstraps labels at scale | (a) Idea: bootstrap from existing data: we import OSM tags (`kerb=*`, `sidewalk=*`, `highway=steps`, `crossing=*`). (b) If its weights are usable, use them as the **US-trained baseline** in our domain-gap experiment | India has no government ramp inventory, so OSM + our labels replace it |
| **Panorama tools** (`sidewalk-panorama-tools`) | Fetch and process imagery | Replaced by a Mapillary API v4 downloader + our own capture page | Licence-clean data |
| **Public data API / per-city deployments** | Open label data per city | Open GeoJSON API of barriers, coverage and reach | Starts with one Delhi zone |
| **Neighbourhood accessibility scoring** | City-level accessibility summaries | Extended into the **Reach Gap**: network-based reach from an anchor (metro station, hospital, school), plus fix ranking | Anchors chosen for Indian last-mile needs (metro, bus stop, hospital) |

**What SAMAAN adds beyond Project Sidewalk:** India barrier classes · three segment states (clear / blocked / unknown) and routing that accounts for coverage · side-aware snapping on synthesised footpaths · Reach Gap + fix ranking · wheels-as-sensors verification · temporary barriers by time of day · Hindi UI · active-learning loop from reports.

**Prior art to acknowledge honestly in the pitch:** Project Sidewalk (labelling), AccessMap (profile-based accessible routing, Seattle), the Government of India **Sugamya Bharat app** (citizen reporting of inaccessible places), research on measuring sidewalk roughness with smartphone accelerometers. Our novelty is the combination for Indian footpaths, plus honest coverage and the Reach Gap. Do not claim "first ever".

---

## 3. Indian barriers we target

Detector classes must be visually distinct and learnable from ~600–1000 images. Everything else is **report-only** or **inferred**.

### 3a. Detector classes (trained)
| # | Class | Project Sidewalk equivalent | Indian example |
|---|---|---|---|
| 1 | `curb_ramp` | CurbRamp | Ramp at a crossing (a positive label, needed to infer missing ramps) |
| 2 | `steps_or_high_kerb` | NoCurbRamp / height difference | Footpath raised well above the road with no ramp; steps at shop fronts |
| 3 | `broken_surface` | SurfaceProblem | Broken or missing slabs, uprooted tiles |
| 4 | `open_drain` | SurfaceProblem (India-specific) | Open nala, missing or broken drain cover |
| 5 | `fixed_obstacle` | Obstacle (pole/tree tags) | Electric pole, transformer box, tree trunk, signboard in the path |
| 6 | `parked_vehicle` | Obstacle (parked car tag) | Two-wheelers, cars or autos parked on the footpath (**temporary**) |
| 7 | `vendor_encroachment` | — (new) | Stalls and carts occupying the footpath (**temporary**, time-of-day) |
| 8 | `bike_barrier` | — (new) | Metal chicanes or bollards at footpath entries meant to stop bikes, which also block wheelchairs |

### 3b. Report-only / inferred
- `no_footpath`, `footpath_end`: inferred from the footpath graph and coverage; can also be reported.
- `missing_ramp_at_crossing`: **inferred**. If both ends of a crossing edge were observed and no `curb_ramp` was detected near an end, flag it.
- `waterlogging`, `construction`, `lift_out_of_service` (foot overbridges, metro): report-only, temporary, with an expiry.
- `foot_overbridge_stairs_only`: from OSM (`highway=steps` on bridges) and reports.

### 3c. Temporary vs permanent
- **Permanent** (steps, drain, pole, broken surface) stays until a **fix is reported and validated**.
- **Temporary** (parked vehicles, vendors, waterlogging) gets a **time-of-day probability profile** built from observation timestamps, and expires when it hasn't been seen recently. Routing uses the probability for the trip's departure time.

### 3d. Standards
Profile thresholds (ramp gradient, minimum clear width, kerb height) must live in `config/profiles.yaml` with a comment citing the source. Source: *Harmonised Guidelines and Standards for Universal Accessibility in India 2021* (MoHUA). **The agent must not hard-code values from memory**: leave a `TODO: cite` placeholder until a human confirms the value from the document.

---

## 4. Architecture

```
            ┌───────────────────────── DATA LAYER (offline) ─────────────────────────┐
            │ OSM roads + tags ──► Footpath synthesis ──► Footpath graph (L/R sides,  │
            │                       (offset lines,          crossings, OSM kerb tags) │
            │                        crossings)                  │                    │
            │ Mapillary v4 + own capture (photo, GPS, heading, time)                   │
            │        │                         │                                       │
            │        ▼                         ▼                                       │
            │   Detector (YOLO) ──► Geolocate + side-aware snap ──► Barrier layer     │
            │        │                                                │               │
            │        └────────── Coverage (which edge sides were seen) ┘               │
            │                                    ▼                                     │
            │                      Segment state: clear / blocked / unknown            │
            └───────────────────────────────────┬─────────────────────────────────────┘
                                                ▼
     ┌──────────────── SERVICES (FastAPI, in-memory NetworkX graph) ──────────────────┐
     │ /route (3 modes, profiles, verified %)   /reach (Reach Gap, fix ranking)       │
     │ /reports (create, validate, fixed)       /missions   /ride (wheel sensor data) │
     │ /layers (GeoJSON: footpaths, barriers, coverage)                                │
     └───────────────────────────────────┬────────────────────────────────────────────┘
                                         ▼
     ┌──────────────── WEB APP (React PWA, MapLibre) ─────────────────────────────────┐
     │ Route compare · Reach Gap view · Report · Validate · Missions · Ride mode       │
     │ Hindi/English · large touch targets · screen-reader labels · high contrast      │
     └─────────────────────────────────────────────────────────────────────────────────┘
          ▲ feedback: validated reports + wheel traces update segment state; confirmed
            report photos are exported as new training data (active learning)
```

### Tech stack
| Part | Choice | Notes |
|---|---|---|
| Language | Python 3.11 (backend/ML), TypeScript (frontend) | |
| Graph | OSMnx, NetworkX, Shapely 2, GeoPandas, pyproj | Projected CRS **EPSG:32643** (UTM 43N, Delhi) for all metric geometry |
| ML | Ultralytics YOLO (nano/small) | **AGPL-3.0**, so the repo must stay open source (fine for the hackathon) |
| Labelling | Roboflow or CVAT (human task) | Export in YOLO format |
| Backend | FastAPI + SQLModel on SQLite | Geometry stored as GeoJSON/WKT; graph loaded into memory at startup. Move to PostGIS only if needed |
| Frontend | React + Vite + TypeScript + MapLibre GL JS | Basemap: an OSM-based tile source that allows low-volume demo use (check its usage policy) |
| Sensors | Browser `DeviceMotionEvent` + `Geolocation.watchPosition` | Needs HTTPS; iOS needs `DeviceMotionEvent.requestPermission()` on a user tap |
| Optional hardware | ESP32 + MPU6050 | Stretch only (Phase 9b) |

### Repo layout
```
samaan/
  config/            zone.yaml, profiles.yaml, taxonomy.yaml, fix_costs.yaml
  data/              raw/ (gitignored), processed/, ground_truth/
  pipeline/          graph/, ingest/, detect/, geolocate/, coverage/, state/
  ml/                train.py, eval.py, domain_gap.py, export_active_learning.py
  api/               FastAPI app, routers, services (routing, reach, reports, rides)
  web/               React PWA
  eval/              scripts that produce every number used in the pitch
  docs/              labelling_guide.md, demo_script.md, PROGRESS.md
  tests/
```

---

## 5. Data model (core tables)

- **footpath_edge**: id, geometry (LineString), length_m, side (L/R/none), parent_road_osm_id, kind (sidewalk/footway/crossing/steps), osm_tags, width_m (nullable), state (clear/blocked/unknown), state_confidence, last_observed_at, observed_by (image/wheel/report)
- **footpath_node**: id, geometry, kind (junction/crossing_end/anchor)
- **image**: id, source (mapillary/own/report), lat, lon, heading_deg, pitch_deg (nullable), hfov_deg, captured_at, width, height, path
- **detection**: id, image_id, class, score, bbox (x1,y1,x2,y2), est_lat, est_lon, est_distance_m, assigned_edge_id, side, snap_confidence
- **barrier**: id (cluster of detections/reports), class, severity (1–5), tags[], edge_id, position_along_edge_m, permanent (bool), time_profile (24 hourly probabilities, for temporary barriers), status (active/fixed/expired), confidence, sources[]
- **report**: id, user_id, photo_image_id, class, severity, note, lat, lon, heading, status (pending/verified/rejected/fixed), model_prescreen_score, created_at
- **vote**: report_id, user_id, value (agree/disagree/unsure), created_at
- **user**: id, display_name, trust_score, profile (wheelchair_manual/elderly/pram/walker), language
- **ride**: id, user_id, started_at; **ride_sample**: ride_id, t, lat, lon, gps_accuracy, az (vertical accel), ax, ay
- **edge_ride_stat**: edge_id, roughness_index, n_traversals, last_traversed_at, jolt_events[]

---

## 6. How each technical piece works

### 6.1 Footpath graph (Indian OSM rarely maps footpaths)
1. Download all roads in the zone polygon with OSMnx, plus any `highway=footway|path|steps|pedestrian` and tags `sidewalk=*`, `kerb=*`, `crossing=*`, `wheelchair=*`.
2. **Synthesise footpaths:** for each road without `sidewalk=no`, create left and right lines with `shapely.offset_curve` at `road_half_width + 1.0 m`. Road half width comes from `width` or `lanes × 3.5 / 2`, with a default per road class. Trim the lines at junctions.
3. **Crossings:** at every junction, and at every OSM `highway=crossing` node, add crossing edges connecting the corresponding sidewalk endpoints on opposite sides. Crossings carry `signal`, `kerb_ramp_start/end` (unknown until observed).
4. Keep real OSM footways, and connect them to the synthesised sidewalks within 5 m.
5. **Human correction loop:** export to GeoJSON, fix it in QGIS/JOSM, re-import. Then run a graph validation report: connected components, dangling edges, crossings with no ends.

### 6.2 Image ingest and coverage
- **Mapillary API v4:** query images in the zone bbox, with fields `id, computed_geometry, computed_compass_angle (fallback compass_angle), captured_at, camera_parameters, thumb_2048_url`. Store a licence/attribution string.
- **Own capture page** (PWA route `/capture`): takes a photo every N metres or on tap, and logs GPS, accuracy, compass heading (`DeviceOrientationEvent`, using `webkitCompassHeading` on iOS), pitch, timestamp and camera HFOV (default 65°, configurable). The team walks **both sides of every street** in the zone.
- **Coverage:** an edge side counts as *observed* if at least K images (default 2) have a camera position within 15 m of the edge **and** a view cone (heading ± HFOV/2, range 20 m) that intersects it. Observed with no barrier → `clear`. Never observed → `unknown`.

### 6.3 Detector
- Taxonomy in `config/taxonomy.yaml` (Section 3a). The labelling guide in `docs/labelling_guide.md` includes example rules for each class and for severity.
- **Split the data by street, not by image.** One whole street is the held-out test street, so frames of the same barrier can't leak between train and test.
- Train YOLO nano/small with augmentation suited to Indian conditions (brightness, haze, blur, partial occlusion).
- **Domain-gap experiment** (`ml/domain_gap.py`): evaluate a non-Indian baseline (RampNet's kerb ramp model if its weights are usable, otherwise a model trained only on non-Indian Mapillary images with the shared classes) on our Indian test street, then compare with our fine-tuned model. Output: per-class precision/recall table. **[MEASURE]**
- Run inference on all zone images and save the detections.

### 6.4 Geolocation and side-aware snapping
For each detection:
1. **Bearing to object:** `bearing = heading + ((cx / W) − 0.5) × HFOV`.
2. **Distance:** ground-plane model. Camera height `h` (default 1.3 m handheld; configurable), angle below the horizon `α = ((y_bottom / H) − 0.5) × VFOV + pitch`, `d = h / tan(α)`, clamped to 1–25 m. Fallback d = 6 m. Optional upgrade: a monocular depth model.
3. **Position:** offset the camera GPS position by `d` along `bearing` (in EPSG:32643).
4. **Side of road:** find the nearest road centreline; the sign of the 2D cross product (road direction × vector to the point) gives left or right. Cross-check against whether the object is left or right of the camera's travel direction; if they disagree, lower the confidence.
5. **Snap** to the nearest footpath edge **on that side** within 12 m, and record `position_along_edge_m`.
6. **Dedupe:** run DBSCAN per class on snapped points (eps 4 m, same edge side). Each cluster becomes one `barrier`. More sightings → higher confidence; severity = median of the labels.
7. **Snap confidence** combines GPS accuracy, distance, side agreement and number of sightings.
8. **Baseline for comparison:** a naive snapper (nearest footpath edge to the camera GPS position, ignoring side). `eval/snapping_eval.py` compares both against `data/ground_truth/snapping.csv` (about 100 barriers whose true edge and side a human recorded). **[MEASURE]**

### 6.5 Segment state
- `blocked` if any active barrier on the edge is impassable for at least one profile; otherwise `clear` if observed (images or wheels) within the staleness window (default 180 days for permanent barriers); otherwise `unknown`.
- Temporary barriers contribute `P(present at hour h)` from `time_profile`.

### 6.6 Routing
- **Profiles** (`config/profiles.yaml`): `wheelchair_manual`, `elderly_walking_aid`, `pram`, `walker`. For each barrier class + severity: `impassable` or `penalty_seconds`. Speeds are configurable (`TODO: cite` sources).
- **Edge cost** = `length / speed + Σ barrier penalties + unknown_penalty`. Impassable edges are removed for that profile. Temporary barriers apply `P(present at departure hour) × penalty`, or are treated as impassable above a threshold.
- **Unknown handling** (user setting, called "risk tolerance"): `strict` = unknown edges cost ×5, `balanced` = ×1.5, `relaxed` = ×1.0.
- **Three route modes** returned together for the comparison view:
  1. `shortest`: walker profile, ignores barriers (what a normal map does)
  2. `naive_accessible`: avoids known barriers but treats unknown as clear (what most accessible-routing demos do)
  3. `samaan`: profile rules + unknown penalty
- **Response:** geometry, length, ETA, barriers encountered (with photos), **verified %** (clear length / total), list of unknown stretches with lengths.
- Algorithm: NetworkX A* with a straight-line heuristic. The graph fits in memory for a 1–2 km² zone.

### 6.7 Reach Gap and fix ranking
- **Anchors:** metro station exits, bus stops, hospital, school. Defined in `config/zone.yaml` and snapped to graph nodes.
- **Reach:** single-source Dijkstra from the anchor with a time cutoff T (default 10 min) per profile. Metric = **total reachable footpath length (km)**, which is more honest than area. For display, draw a concave hull polygon of the reached edges.
- **Reach Gap** = walker reach − wheelchair reach, also shown as a ratio.
- **Fix ranking (greedy):** candidates = active barriers on edges within walker reach. For each candidate, mark it fixed, recompute wheelchair reach, and record the gain. Pick the best, apply it, and repeat up to k = 5. Divide by the estimated cost (`config/fix_costs.yaml`, rough ₹ ranges labelled "estimate") to give **reach gained per ₹ lakh**.
- **UI:** two reach blobs (walker vs wheelchair), the gap number, the top-5 fix list, and a "simulate fix" toggle that animates the blob growing.

### 6.8 Report (citizen reporting of undetected barriers)
1. A **one-tap Report** button on the map and route screens opens the camera, auto-captures GPS, heading and timestamp, and shows a class picker with icons (Hindi/English), severity (1–5, with pictures) and an optional note.
2. **Server pipeline:** store → run the detector on the photo (the pre-screen score raises or lowers the starting confidence) → geolocate and snap (6.4) → `pending`.
3. **Validate queue** (Project Sidewalk style): other users near the location see the photo and a mini-map and vote agree / disagree / unsure. Score = Σ(vote × voter trust). Verified at or above the threshold → creates or updates a `barrier` → segment state and routes update immediately.
4. **Trust score:** rises when a user's reports and votes agree with consensus, falls otherwise. New users start low.
5. **Abuse checks:** rate limits; reject reports where the photo's GPS is more than 50 m from the device location; duplicate detection against existing barriers within 4 m.
6. **Fixed flow:** anyone can mark a barrier "fixed" with a new photo, which goes through the same validation and then closes the barrier.
7. **Active learning:** verified report photos with their class are exported in YOLO format (`ml/export_active_learning.py`) for the next training round. Every missed barrier a citizen reports makes the model better.

### 6.9 Missions (targeted gap-filling)
- Sample 500 random origin–destination pairs inside the zone, plus all anchor-to-destination pairs, and route them with the `samaan` mode.
- **Mission priority** of an unknown edge = (number of routes using it or detouring around it) × length.
- The Missions screen lists the top 10 unknown stretches. Completing one means capturing images along it via `/capture`, after which coverage recomputes.

### 6.10 Wheels as sensors
- **Ride mode** (PWA): the user taps Start (this also requests motion permission on iOS); the phone is mounted on the wheelchair. Records accelerometer data at about 50 Hz and GPS at 1 Hz, uploading in batches every 10 s (cached offline if needed).
- **Processing:** high-pass filter the vertical acceleration (remove gravity) → compute RMS and peak per 1 s window → map-match each window to the nearest footpath edge within 10 m whose direction agrees with the GPS heading.
- **Per edge:** `roughness_index` = median RMS over traversals. A smooth traversal of ≥80% of the edge's length counts as **verified by wheels** → `clear`.
- **Jolt event** (peak above the calibrated threshold) → creates a `suspected` barrier at that spot, and adds a mission to photograph it, or prompts the rider to snap a photo when they stop.
- **Calibration tool:** record rides over a known kerb, a known smooth stretch and a known broken stretch; the script picks thresholds and plots them. **[MEASURE]**
- **9b (stretch):** ESP32 + MPU6050 clip-on that streams to the phone over Web Bluetooth (Chrome/Android) or Wi-Fi POST. The phone-only version must work first.

### 6.11 The app must itself be accessible
Minimum touch target 48 px, every control labelled for screen readers, high-contrast theme, usable one-handed, no colour-only meaning (icons and text alongside colour), Hindi and English strings from the start (i18n files), works on a mid-range Android phone over 4G.

---

## 7. Build phases

Every phase ends with tests passing, an updated `docs/PROGRESS.md`, and a commit. **Phase 0 creates seeded synthetic data so the API and UI never wait for the ML.**

| Phase | Goal | Agent builds | Humans do | Done when |
|---|---|---|---|---|
| **P0 Foundations** | Skeleton that runs end to end on fake data | Repo layout, configs, data model, `make seed` (synthetic barriers + coverage on a real OSM graph of the zone), test setup, `docs/PROGRESS.md` | Choose the demo zone (1–2 km² around one metro station) and anchors | `make seed && make api` serves GeoJSON layers; tests pass |
| **P1 Footpath graph** | Usable footpath network | 6.1 synthesis, crossings, OSM tag import, export/import for correction, validation report | Correct the graph in QGIS/JOSM (2–3 h) | Corrected graph loads; validation report shows one main component |
| **P2 Ingest & capture** | Images with heading | Mapillary downloader, `/capture` page, image table, coverage computation (6.2) | Photo walks on both sides of every street (with GPS + heading) | Coverage layer shows observed vs unknown edge sides |
| **P3 Detector** | India-trained model | Taxonomy, labelling guide, street-based split, train/eval scripts, domain-gap script, batch inference | Label 600–1000 images in Roboflow/CVAT | Per-class P/R on the held-out street is written to `eval/results/` |
| **P4 Geolocate & snap** | Barriers on the right segment and side | 6.4 pipeline, DBSCAN dedupe, naive baseline, `eval/snapping_eval.py`, segment state (6.5) | Record ~100 ground-truth barrier positions (edge + side) | Snapping accuracy, ours vs baseline, is in `eval/results/` |
| **P5 Routing API** | Three route modes with verified % | Profiles, 6.6 engine, `/route`, unit tests on a toy graph | Review profile rules; fill in `TODO: cite` values from the Harmonised Guidelines | API returns three routes with verified %, barriers and unknown stretches |
| **P6 Web app core** | Demo-able map | Layers (footpaths by state, barriers with photos), search, three-panel route compare, profile + risk-tolerance selector, i18n, accessibility (6.11) | Hindi strings review | Three-route comparison works on a phone |
| **P7 Report, Validate, Missions** | Citizen loop | 6.8 + 6.9: report flow, prescreen, validation queue, trust, fixed flow, active-learning export, missions screen | Test the report flow on the street | A new report goes pending → verified → route changes, live |
| **P8 Reach Gap** | The headline number | 6.7 reach, gap, greedy fix ranking, cost table, blob view + simulate fix | Rough fix-cost ranges (label them as estimates) | Reach Gap and top-5 fixes are shown for every anchor |
| **P9 Wheels as sensors** | Passive verification | Ride mode, upload, processing, map-matching, roughness index, jolt → suspected barrier, calibration tool; 9b ESP32 stretch | Calibration rides; borrow a wheelchair or use a trolley/pram for testing | A ride flips unknown edges to "verified by wheels" on the map |
| **P10 Eval, demo, polish** | Credible numbers + safe demo | `eval/run_all.py` reproduces every pitch number, demo mode (pre-loaded state, reset button, recorded ride replay, offline fallback), README, `docs/demo_script.md` | Interview 2–3 wheelchair users / a disability NGO; rehearse | Every pitch number traces to a script output; demo runs offline |

**If time runs short, cut in this order:** P9b ESP32 → temporary-barrier time profiles → missions → trust weighting (simple majority instead) → P9 entirely. **Never cut:** P1, P4 + snapping eval, P5 verified %, P8 Reach Gap, P7 basic report.

---

## 8. Evaluation (every number in the pitch comes from here)

| Metric | Script | Compared against |
|---|---|---|
| Detector precision/recall per class on the held-out street | `ml/eval.py` | Non-Indian baseline (`ml/domain_gap.py`) |
| Snapping accuracy (correct edge + side) | `eval/snapping_eval.py` | Naive nearest-edge snapper |
| Barriers encountered per trip, 20+ random OD pairs | `eval/routing_eval.py` | `shortest` and `naive_accessible` modes |
| Verified % of routes | `eval/routing_eval.py` | `naive_accessible` (which claims 0 barriers on unknown footpaths) |
| Reach Gap per anchor, and gain from the top-5 fixes | `eval/reach_eval.py` | Walker reach |
| Wheel jolt detection vs known barriers | `eval/ride_eval.py` | Ground-truth kerbs from calibration rides |

---

## 9. Demo script (3 minutes)

1. **Reach Gap reveal:** a map around the metro station, with walker and wheelchair reach blobs and the gap number in large type.
2. **Same trip, three routes:** shortest (N barriers, with photos) → naive accessible ("0 barriers", but X% never seen) → SAMAAN (fully verified, slightly longer).
3. **Report live:** photograph an unreported obstacle → model pre-screens it → a teammate validates on a second phone → the route reroutes.
4. **Wheels:** replay (or do live) a ride over an unknown stretch; it turns to "verified by wheels".
5. **The city's to-do list:** top-5 fixes, tap "simulate fix", the wheelchair blob grows.
6. **Close:** "Built on Project Sidewalk's ideas, rebuilt for Indian footpaths: vendors, open drains, bike barriers, and honest about what we haven't seen."

---

## 10. Risks and mitigations
| Risk | Mitigation |
|---|---|
| OSM has no footpaths in the zone | Synthesis + human correction (P1); keep the zone small |
| Weak detector | Report the numbers honestly; demo zone hand-verified; the report loop and wheel data fill gaps |
| GPS noise puts barriers on the wrong side | Side-aware snapping + confidence; showing this is the point of the snapping eval |
| Mapillary coverage thin | Own photo walks are the primary source |
| iOS sensor permissions / HTTPS | Serve over HTTPS (tunnel for demo); test on Android first |
| Live demo failure | Demo mode with pre-loaded state and recorded replays (P10) |

---

## 11. Rules for the coding agent
1. Work **one phase at a time**, in order. At the start of each phase, write a short plan in `docs/PROGRESS.md`; at the end, record what was built, how to run it, and open issues.
2. **Never fabricate metrics or data.** Evaluation numbers come only from scripts run on real data. Synthetic seed data must be clearly flagged `synthetic=true` and never used in eval outputs.
3. Keep every threshold, speed, penalty and standard in `config/*.yaml`. Values from Indian standards get a `TODO: cite` until a human confirms them.
4. Use the stack in Section 4. Ask before adding a major dependency or changing the architecture.
5. Write tests for geometry (offsets, side assignment, snapping), routing (toy graphs) and reach (known answers).
6. Respect data licences: no Google Street View imagery; store Mapillary attribution; ODbL attribution for OSM.
7. Anything that needs a human (labelling, photo walks, graph correction, ground truth, interviews) goes in `docs/PROGRESS.md` under "Human tasks", with exact instructions.
8. Commit at the end of each phase with a clear message.
