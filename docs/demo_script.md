# Demo script — Manipal University Jaipur (hackathon venue)

Zone: `config/zone.yaml` (`muj`). Everything below runs against the live API; nothing is pre-recorded.
Counters shown in the app (More → Demo) come from `GET /demo/status` and distinguish real data from
the synthetic seed.

## 0. Before the jury arrives (10 min)

1. Laptop: `make api-lan` (API on 0.0.0.0:8000) and the cloudflared tunnel (see `docs/IOS_APP.md`).
   If the tunnel URL changed, `make ios-sync API_URL=<url>` and reinstall the app.
2. Phone: open SAMAAN, More → Demo → **Reset demo data** (tap twice). Counters: real photos,
   coverage %, real barriers, reports 0, rides 0.
3. Phone: Settings → "Change how I move" so the jury sees the first-run screen when you start.

## 1. Three users, three screens (3 min)

Tell the story: Riya (wheelchair), Aman (autistic, 19, finds maps overwhelming), Meera (blind).

1. **First run.** "How do you move?" → pick **Wheelchair** → Move opens. Point out: the live blue dot,
   "From: My location ±8 m", the Report button, the demo-seed badge.
2. **Move.** Home → *Try the demo trip*. Two cards: *Fastest* vs *SAMAAN*, each with a confidence ring
   (verified %, freshness, barrier evidence, known %). Start → black turn banner, bottom sheet with
   arrival time / minutes / km. Tap *Simulate walk* if GPS is weak indoors.
3. **Explore.** Settings → Change how I move → **Autistic or dyslexic** → Home → demo trip. The camera
   opens with the Sanskriti-style HUD: one big arrow, "Turn 40° right · 25 m", "SAMAAN says" card.
   Rotate the phone: the arrow stays on the ground direction.
4. **Listen.** Settings → Change how I move → double-tap anywhere on the welcome screen (or say
   "I can't see"). SAMAAN greets by voice and listens. Say *"library"* → "Found Central Library. Say
   yes to go." → *"yes"* → spoken directions. While walking say *"where am I"*, *"report"* (→ "What is
   blocking the way?" → *"parked scooter"* → *"yes"* → report sent), *"stop"*.

## 2. Real-time data collection (2 min)

1. Contribute → Capture: a teammate walks 30 m along the footpath outside the hall with auto-capture.
2. More → Demo → Refresh: real photos +N, coverage % up. More → Map: the stretch turns green.
3. Report a parked bike with a photo on phone A; phone B (team user) opens Validate → Agree → the
   barrier appears, the SAMAAN route re-plans around it (Move: route card updates).
4. Contribute: the points moved; show the CSR partner coupons.

## 3. Wheels as sensors + Reach Gap (1 min, if time)

- More → Demo → *Replay demo wheelchair ride*: stretches verified by wheels, a jolt becomes a
  suspected barrier.
- More → Reach Gap: how far a wheelchair user gets from the main gate in 10 min vs a walker, and
  which three fixes close most of the gap.

## Collecting real campus photos (teammates, 45 min, 2–3 phones)

Yes: real photos of our own building and its approaches make the demo honest. Do it with the app,
not the phone camera, so every photo carries GPS, heading and pitch and uploads itself.

1. Each phone: SAMAAN → Contribute → Capture. Allow camera, location and motion. Check "Auto-capture".
2. Routes to walk (phone upright, camera forward, normal pace, one photo every 10 m is automatic):
   - main gate → academic block entrance (both sides of the road),
   - academic block → the hall where the demo runs, including every ramp, kerb and crossing,
   - hostel road → canteen,
   - any footpath with steps, parked two-wheelers, open drains, construction.
3. At each barrier: stop, point the camera at it, hold still for one frame, then also tap *Report a
   barrier* and choose the class (that produces a citizen report + photo, which the zero-shot detector
   pre-screens).
4. Check uploads on Contribute → Upload queue (captured / uploaded). On Wi-Fi with client isolation,
   uploads go through the tunnel URL baked into the app.
5. Back at the laptop: `make infer-zero-shot` (detections on the new photos) → `make geolocate`
   (barriers) → `POST /route/reload`, or simply `curl -X POST <api>/coverage/recompute` for coverage
   only (uploads already trigger this).

   **Photos taken with the phone's own camera app** (JPEG or HEIC with location on): AirDrop or
   copy them into one folder on the laptop, then
   `make import-photos DIR=~/Downloads/campus-walk` — it reads GPS, compass heading and time from
   EXIF, converts HEIC, uploads each photo as own coverage and lists the ones without GPS. Then the
   same three commands as above.
6. More → Demo → Refresh: real photos, coverage % and real barriers should reflect the walk.

What not to do: no Google Street View screenshots, no photos of people's faces up close, no staged
barriers you then remove without reporting them fixed.
