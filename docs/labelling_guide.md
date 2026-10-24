# SAMAAN labelling guide (detector classes, severity, tags)

Who: the team, in Roboflow or CVAT. What: 600–1000 street-level images from the Karkarduma
zone (own photo walks first, Mapillary second). Output: a YOLO-format export imported with
`python -m ml.dataset import <export_dir> --name karkarduma_v1`.

Rules that keep the numbers honest (plan 6.3):
- **Label whole streets.** The test set is one complete street, so label every usable frame of
  a street before moving to the next. Never cherry-pick "nice" frames.
- **Name the street.** Own photos carry the capture session id (`<street>-<side>`); Mapillary
  photos carry a sequence id. Keep both in the export filenames (`<image_id>.jpg` as uploaded).
- **Box what blocks the footpath**, not everything in the scene. One box per physical thing.
- **When unsure between two classes, pick the class and add the `uncertain` tag** rather than
  skipping; QA resolves it.
- No Google Street View frames, ever.

## Classes (config/taxonomy.yaml, YOLO index in brackets)

| Class | Box exactly this | Do not label | Severity cues |
|---|---|---|---|
| `curb_ramp` [0] | The sloped kerb cut, from top landing to road edge, at a crossing or footpath entry. Positive class: we need it to infer *missing* ramps. | Driveway aprons into private plots; ramps steeper than a flight of steps (use `steps_or_high_kerb`). | 1 if smooth and flush; 2–3 if lip > a few cm, no landing, or ramp ends in a drain/puddle (tags `too_steep`, `no_landing`). |
| `steps_or_high_kerb` [1] | The step riser(s) or the raised footpath edge where a wheelchair would have to climb. Include the full width you can see. | Kerbs along the road where nobody needs to cross (only label at crossings, footpath ends and shop fronts). | 2 = one low step/kerb (ankle), 3 = one high step (shin), 4 = two steps or high kerb with no ramp, 5 = three+ steps / stairs. Tags: `steps`, `two_steps`, `high_kerb`, `no_ramp`. |
| `broken_surface` [2] | The damaged patch: missing/broken slabs, uprooted tiles, deep cracks, exposed rebar, potholes on the footpath. | Dirt, stains, normal joints between slabs. | 1 = cosmetic, 2 = would jolt a wheelchair, 3 = must slow and steer around, 4 = wheel could get stuck, 5 = impassable hole. Tags: `cracks`, `uneven`, `tree_root`, `construction_debris`. |
| `open_drain` [3] | The opening: missing or broken drain cover, open nala edge on the footpath, gap wider than a wheel. | Covered drains with intact grating. | 3 = narrow gap a castor could drop into, 4 = cover missing on part of the width, 5 = open drain across the whole footpath. |
| `fixed_obstacle` [4] | The permanent object standing on the footpath: electric pole, transformer box, tree trunk, signboard post, bollard not meant as a bike barrier. Box the base and trunk, not the canopy. | Objects beside the footpath that leave it clear; moving people. | 1 = leaves ample width, 2–3 = narrows it, 4 = leaves less than a wheelchair width, 5 = blocks it. Tags: `pole`, `transformer_box`, `narrow`. |
| `parked_vehicle` [5] | Each vehicle standing on the footpath: two-wheeler, car, auto. One box per vehicle. | Vehicles on the road. Moving vehicles. | 2 = partly on the footpath, 3 = narrows it, 4 = less than a wheelchair width left, 5 = blocks it. Tags: `two_wheeler`, `parked_car`, `auto_rickshaw`. **Temporary** class: also note time of day in the image metadata. |
| `vendor_encroachment` [6] | The stall, cart, goods display or seating that occupies the footpath. Box the footprint on the footpath. | Shops inside their own frontage. | Same width rule as parked vehicles. Tags: `cart`, `stall`. **Temporary** class. |
| `bike_barrier` [7] | The chicane, railing gate or bollard row placed at a footpath/park entry to stop bikes. Box the whole arrangement. | Fences along the edge of the footpath. | 3 = passable by a narrow wheelchair with effort, 4 = only on foot, 5 = closed. Tags: `chicane`, `bollard`, `narrow`. |

Report-only classes (`no_footpath`, `footpath_end`, `waterlogging`, `construction`, …) are **not**
labelled for the detector; they come from the graph, reports and OSM.

## Severity in one sentence
Severity answers "for a manual wheelchair user, how much does this single thing cost?":
1 nuisance · 2 slows · 3 needs effort or help · 4 needs a detour · 5 cannot pass. It is a
per-box attribute in the annotation tool (Roboflow: attribute `severity`; CVAT: attribute on the
label). If the tool cannot export attributes, write severity as a suffix in the class name
(`parked_vehicle_3`) and the importer will split it.

## Boxing rules
- Tight boxes, include the base/ground contact; include the part that matters for passing.
- Partially visible or occluded: label if at least ~30% is visible and the class is clear.
- Night, heavy blur, or the footpath is not visible: skip the whole image (tag the image
  `unusable` in the tool so the importer excludes it).
- Several similar objects (five two-wheelers in a row): one box each, not one big box.
- The same barrier in consecutive frames gets labelled in every frame; the street-based split
  keeps them on one side of the train/test line.

## Quality control
- Two people label the first 50 images independently, then compare and fix the guide here.
- 10% of all images get a second pass; disagreements go back to this guide as clarifications.

## Export and import
1. Roboflow: Generate → Export → "YOLOv8" (txt), no augmentation, no resize. CVAT: Export →
   "YOLO 1.1" or "Ultralytics YOLO Detection".
2. Unzip to `data/labels/<name>_export/` (gitignored images) and run
   `python -m ml.dataset import data/labels/<name>_export --name <name>`.
   The importer maps class names via `config/taxonomy.yaml` (ids and `aliases`), builds
   `manifest.csv` (file, image_id, source, lat, lon, street, n_labels, synthetic=false) and
   reports images it could not match to the `image` table (then street comes from the filename
   or is "unknown").
3. `python -m ml.dataset split --name <name>` picks the held-out test street (closest to 15% of
   boxes unless `--test-street` is given) and writes `data.yaml` + `splits.json`.
4. `python -m ml.train --name <name>` → `python -m ml.eval --name <name> --weights …`.

## Example images
Human task: add two example photos per class (one typical, one borderline) to
`docs/labelling_examples/` and reference them in the table above before labelling starts.
