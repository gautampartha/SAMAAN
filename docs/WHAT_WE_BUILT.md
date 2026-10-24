# SAMAAN in one page (for the team and the judges)

**One sentence.** SAMAAN tells a person with a disability which footpath they can actually use,
right now, and how sure we are, and it gets better every time anyone walks with it.

## The problem statement, line by line

| They asked for | What SAMAAN does | Where |
|---|---|---|
| Detect barriers in street-level images | Photos (phone, Mapillary, citizen reports) go through a detector. Today a pretrained model finds vehicles and obstacles; the India-trained model is trained the moment the team's labelled photos exist. | `ml/`, `config/zero_shot.yaml` |
| Match detections to the correct footpath segment | From the photo's GPS, compass heading and the box position we estimate where the barrier is, which **side of the road** it is on, and snap it to that side's footpath. A naive "nearest footpath" baseline exists for comparison. | `pipeline/geolocate/` |
| Plan routes with barrier costs | A footpath network built from OpenStreetMap (real footways where mapped, synthesised sidewalks elsewhere), six user profiles with their own costs, and A* routing. | `pipeline/graph/`, `api/services/routing.py` |
| **Phase 2:** photo reports update barriers within a minute; temporary barriers expire | Report with a photo → trusted reporters are verified instantly, others after one more vote → the barrier, the segment and every route update before the response returns. Parked vehicles and vendors expire after 14 days unseen. | `api/services/reports.py`, `pipeline/state/expire.py` |
| **Phase 2:** 3+ profiles with different costs | Wheelchair, elderly with walking aid, pram, cognitive (dyslexic/autistic), blind/low vision, plus the walker baseline. Each has its own barrier and crossing rules. | `config/profiles.yaml` |
| **Phase 2:** confidence per route from image age and coverage | Every route has a score and label (high/medium/low) from verified share, imagery freshness, barrier verification and unknown share. | `route_confidence()` |
| **Phase 2:** report segments with no recent imagery | Every route says "N of M segments have no recent imagery" and lists the unseen stretches. | `/route` response |

## What the mentors asked, and the answer

1. **"How do you collect data in real time?"** The app is the sensor. Navigating can contribute
   a photo every 10 m (with consent). A phone on a wheelchair verifies smooth footpaths and flags
   jolts. Citizens report with photos. Mapillary is pulled with its licence kept. Every route shows
   how old its evidence is, so freshness is never hidden.
2. **"Two routes with confidence, not three."** Done: *Standard* (what any map suggests) and
   *SAMAAN*, each with a confidence score.
3. **"It must work anywhere, without exploring first."** Any area is built from OpenStreetMap on
   demand in under a minute (`POST /zones/rebuild`). A new area starts with every footpath
   honestly marked unknown, routes still work, and the confidence score says so. Central Jaipur:
   6 seconds, 2973 footpath segments.
4. **"Three users, three modes."** Move (map, turn banner), Explore (camera with one big arrow
   and a pictogram per step, minimal text), Listen (spoken turn-by-turn, voice input).
5. **"Phone-first UI."** Rebuilt in the style of modern navigation apps: black turn banner, white
   cards, blue on off-white, bottom sheet with arrival · min · km.

## How a trip flows

Search or say a destination → choose a mode → two routes with confidence → start → turn-by-turn
steps (text, arrow or voice) with warnings for barriers ahead → arrive → optionally contribute the
photos taken on the way. Behind it: footpath graph → barriers (detections, reports, jolts) →
segment states (clear / blocked / unknown) → profile costs → routes → confidence.

## What is real and what is seeded (be honest on stage)

- **Real**: the OpenStreetMap footpath network of the MUJ campus, the 18 Mapillary images of
  2017 and the 2 barriers found in them, every report and ride made during the hackathon, the
  on-demand build of any other area.
- **Seeded (marked "synthetic demo data" everywhere)**: the 33 demo barriers and the coverage
  that make Riya's trip tell its story before real photos exist. `make seed` creates them;
  evaluation scripts refuse them.
- **Not yet**: the India-trained detector (no labelled photos yet; the pipeline, labelling guide
  and GPU hand-off are ready), calibrated ride thresholds, cited standard values.

## Riya's demo trip (campus)

From the main entrance to a lecture hall, 800 m. Standard route: two steps and parked
two-wheelers on the way. SAMAAN route: slightly longer, no impassable barrier, confidence shown,
each step spoken or shown as an arrow depending on the mode. Report a barrier from the second
phone → the route changes while you watch.
