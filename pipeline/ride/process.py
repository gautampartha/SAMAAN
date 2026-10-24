"""Wheels as sensors (plan 6.10): ride samples -> windows -> map-matched edges -> roughness,
verified-by-wheels coverage and suspected barriers from jolts.

Pure functions on lists of samples so the pipeline is unit-testable; `process_ride` wires them
to the database. Accelerations are in m/s² in the device frame including gravity.
"""
from __future__ import annotations

import itertools
import logging
import math
import statistics
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from shapely.geometry import LineString, Point
from sqlmodel import Session, select

from api.models import Barrier, Coverage, EdgeRideStat, FootpathEdge, Ride, RideSample
from common import config
from common.crs import lonlat_to_xy, xy_to_lonlat
from common.geo import bearing_deg
from pipeline.geolocate.geolocate import EdgeIndex

log = logging.getLogger(__name__)


@dataclass
class Sample:
    t: float
    ax: float | None = None
    ay: float | None = None
    az: float | None = None
    lat: float | None = None
    lon: float | None = None
    gps_accuracy_m: float | None = None
    speed_m_s: float | None = None


@dataclass
class Window:
    t0: float
    t1: float
    rms: float
    peak: float
    n: int
    x: float | None = None
    y: float | None = None
    heading_deg: float | None = None
    speed_m_s: float | None = None
    gps_accuracy_m: float | None = None
    edge_id: int | None = None
    position_m: float | None = None
    match_distance_m: float | None = None


@dataclass
class EdgeTraversal:
    edge_id: int
    windows: list[Window] = field(default_factory=list)

    @property
    def rms_values(self) -> list[float]:
        return [w.rms for w in self.windows]

    def covered_fraction(self, edge_length_m: float) -> float:
        pos = [w.position_m for w in self.windows if w.position_m is not None]
        if not pos or edge_length_m <= 0:
            return 0.0
        return min(1.0, (max(pos) - min(pos) + 2.0) / edge_length_m)  # +2 m: a window spans ~a metre each way


# ----------------------------------------------------------------------------- signal


def gravity_axis(samples: list[Sample]) -> str:
    """The axis with the largest mean magnitude carries gravity: the phone's 'vertical'."""
    means = {}
    for axis in ("ax", "ay", "az"):
        vals = [getattr(s, axis) for s in samples if getattr(s, axis) is not None]
        means[axis] = abs(sum(vals) / len(vals)) if vals else 0.0
    return max(means, key=lambda k: means[k])


def highpass(values: list[float], times: list[float], window_s: float) -> list[float]:
    """Subtract a centred rolling mean of `window_s` seconds (removes gravity and slow tilt)."""
    out = []
    j0 = j1 = 0
    n = len(values)
    acc = 0.0
    for i, t in enumerate(times):
        while j1 < n and times[j1] <= t + window_s / 2:
            acc += values[j1]
            j1 += 1
        while j0 < j1 and times[j0] < t - window_s / 2:
            acc -= values[j0]
            j0 += 1
        cnt = j1 - j0
        out.append(values[i] - (acc / cnt if cnt else 0.0))
    return out


def gps_track(samples: list[Sample]) -> list[tuple[float, float, float, float | None, float | None]]:
    """(t, x, y, accuracy, speed) for GPS fixes, in EPSG:32643."""
    out = []
    for s in samples:
        if s.lat is not None and s.lon is not None:
            x, y = lonlat_to_xy(s.lon, s.lat)
            out.append((s.t, x, y, s.gps_accuracy_m, s.speed_m_s))
    return out


def interpolate(track: list[tuple[float, float, float, float | None, float | None]], t: float) -> tuple[float, float, float | None, float | None, float | None] | None:
    """(x, y, heading, speed, accuracy) at time t from the surrounding fixes; None outside the track."""
    if not track:
        return None
    if t <= track[0][0]:
        a, b = track[0], (track[1] if len(track) > 1 else track[0])
    elif t >= track[-1][0]:
        a, b = (track[-2] if len(track) > 1 else track[-1]), track[-1]
    else:
        lo, hi = 0, len(track) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if track[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        a, b = track[lo], track[hi]
    dt = b[0] - a[0]
    f = 0.0 if dt <= 0 else min(1.0, max(0.0, (t - a[0]) / dt))
    x, y = a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])
    dist = math.hypot(b[1] - a[1], b[2] - a[2])
    heading = bearing_deg(a[1], a[2], b[1], b[2]) if dist >= 0.5 else None
    speed = (dist / dt) if dt > 0 else (a[4] if a[4] is not None else None)
    acc = max(v for v in (a[3], b[3]) if v is not None) if (a[3] is not None or b[3] is not None) else None
    return x, y, heading, speed, acc


def make_windows(samples: list[Sample], cfg: dict[str, Any]) -> list[Window]:
    acc = [s for s in samples if s.ax is not None or s.ay is not None or s.az is not None]
    if len(acc) < 5:
        return []
    acc.sort(key=lambda s: s.t)
    axis = gravity_axis(acc)
    times = [s.t for s in acc]
    values = [float(getattr(s, axis) or 0.0) for s in acc]
    hp = highpass(values, times, float(cfg["highpass_window_s"]))
    track = gps_track(samples)
    win = float(cfg["window_s"])
    t_start, t_end = times[0], times[-1]
    windows: list[Window] = []
    t0 = t_start
    i = 0
    while t0 < t_end:
        t1 = t0 + win
        vals = []
        while i < len(times) and times[i] < t1:
            vals.append(hp[i])
            i += 1
        if vals:
            rms = math.sqrt(sum(v * v for v in vals) / len(vals))
            peak = max(abs(v) for v in vals)
            w = Window(t0, t1, round(rms, 4), round(peak, 4), len(vals))
            pos = interpolate(track, (t0 + t1) / 2)
            if pos:
                w.x, w.y, w.heading_deg, w.speed_m_s, w.gps_accuracy_m = pos
            windows.append(w)
        t0 = t1
    return windows


# ----------------------------------------------------------------------------- matching


def edge_bearing_at(geom: LineString, pos: float) -> float:
    a = geom.interpolate(max(pos - 2.0, 0.0))
    b = geom.interpolate(min(pos + 2.0, geom.length))
    return bearing_deg(a.x, a.y, b.x, b.y)


def match_windows(windows: list[Window], edges: EdgeIndex, cfg: dict[str, Any]) -> None:
    """Attach each moving window with usable GPS to the nearest edge within range whose direction
    agrees (either way) with the window heading. Plan 6.10 step 2."""
    max_d = float(cfg["map_match_distance_m"])
    agree = float(cfg["heading_agreement_deg"])
    for w in windows:
        if w.x is None or (w.gps_accuracy_m is not None and w.gps_accuracy_m > float(cfg["max_gps_accuracy_m"])):
            continue
        if w.speed_m_s is not None and w.speed_m_s < float(cfg["min_speed_m_s"]):
            continue
        pt = Point(w.x, w.y)
        for e, g, d in edges.candidates(pt, max_d):
            pos = float(g.project(pt))
            if w.heading_deg is not None:
                diff = abs((edge_bearing_at(g, pos) - w.heading_deg + 180.0) % 360.0 - 180.0)
                diff = min(diff, 180.0 - diff)  # undirected edges
                if diff > agree:
                    continue
            w.edge_id, w.position_m, w.match_distance_m = e.id, pos, round(d, 2)
            break


def traversals(windows: list[Window]) -> list[EdgeTraversal]:
    """Consecutive matched windows on the same edge form one traversal."""
    out: list[EdgeTraversal] = []
    for w in windows:
        if w.edge_id is None:
            continue
        if out and out[-1].edge_id == w.edge_id:
            out[-1].windows.append(w)
        else:
            out.append(EdgeTraversal(w.edge_id, [w]))
    return out


# ----------------------------------------------------------------------------- database


def _samples(session: Session, ride_id: int) -> list[Sample]:
    rows = session.exec(select(RideSample).where(RideSample.ride_id == ride_id).order_by(RideSample.t)).all()
    return [Sample(r.t, r.ax, r.ay, r.az, r.lat, r.lon, r.gps_accuracy_m, r.speed_m_s) for r in rows]


def process_ride(session: Session, ride: Ride, cfg: dict[str, Any] | None = None, now: datetime | None = None) -> dict[str, Any]:
    """Process one ride end to end and persist EdgeRideStat, Coverage(wheel) and suspected barriers."""
    cfg = cfg or config.pipeline()["ride"]
    now = now or datetime.now(UTC)
    samples = _samples(session, ride.id)
    windows = make_windows(samples, cfg)
    edges_idx = EdgeIndex(session.exec(select(FootpathEdge)).all())
    edge_rows = {e.id: e for e in edges_idx.edges}
    match_windows(windows, edges_idx, cfg)
    trav = traversals(windows)
    smooth_thr = float(cfg["smooth_rms_threshold_m_s2"])
    jolt_thr = float(cfg["jolt_peak_threshold_m_s2"])
    verified: set[int] = set()
    stats_out = []
    touched: set[int] = set()
    for tr in trav:
        e = edge_rows[tr.edge_id]
        frac = tr.covered_fraction(e.length_m)
        smooth = all(w.rms <= smooth_thr for w in tr.windows)
        if frac >= float(cfg["verified_fraction_of_edge"]) and smooth:
            verified.add(tr.edge_id)
        st = session.exec(select(EdgeRideStat).where(EdgeRideStat.edge_id == tr.edge_id)).first()
        if st is None:
            st = EdgeRideStat(edge_id=tr.edge_id, synthetic=ride.synthetic)
        st.window_rms = (list(st.window_rms or []) + tr.rms_values)[-500:]
        st.roughness_index = round(statistics.median(st.window_rms), 3) if st.window_rms else None
        st.n_traversals += 1
        st.n_windows += len(tr.windows)
        st.last_traversed_at = ride.started_at + timedelta(seconds=tr.windows[-1].t1) if ride.started_at else now
        st.verified_by_wheels = bool(st.verified_by_wheels or tr.edge_id in verified)
        st.synthetic = bool(st.synthetic and ride.synthetic) if st.id else ride.synthetic
        session.add(st)
        touched.add(tr.edge_id)
    session.flush()
    # coverage by wheels (plan: a smooth traversal of >= 80 % of the edge -> clear)
    for eid in verified:
        last = ride.started_at + timedelta(seconds=windows[-1].t1) if ride.started_at and windows else now
        session.add(Coverage(edge_id=eid, side=edge_rows[eid].side, observed=True, n_images=0, last_observed_at=last,
                             source="wheel", synthetic=ride.synthetic))
    # jolts -> suspected barriers
    jolt_ids: list[int] = []
    merge_d = float(cfg["jolt_merge_distance_m"])
    existing = [b for b in session.exec(select(Barrier)).all() if b.status in ("active", "suspected")]
    for i, w in enumerate(windows):
        if w.edge_id is None or w.peak < jolt_thr:
            continue
        lon, lat = xy_to_lonlat(w.x, w.y)
        near = None
        for b in existing:
            bx, by = lonlat_to_xy(b.lon, b.lat)
            if math.hypot(bx - w.x, by - w.y) <= merge_d:
                near = b
                break
        src = f"ride:{ride.id}:w{i}"
        if near is not None:
            near.sources = list(near.sources or []) + [src]
            near.last_seen_at = now
            session.add(near)
            jolt_ids.append(near.id)
            st = session.exec(select(EdgeRideStat).where(EdgeRideStat.edge_id == w.edge_id)).first()
        else:
            e = edge_rows[w.edge_id]
            b = Barrier(class_id=cfg["jolt_class"], severity=3, tags=["jolt"], edge_id=w.edge_id, side=e.side,
                        position_along_edge_m=float(w.position_m or 0.0), lat=lat, lon=lon, permanent=True, status="suspected",
                        confidence=float(cfg["jolt_confidence"]), sources=[src], note=f"jolt peak {w.peak:.1f} m/s²",
                        created_at=now, last_seen_at=now, synthetic=ride.synthetic)
            session.add(b)
            session.flush()
            existing.append(b)
            jolt_ids.append(b.id)
            st = session.exec(select(EdgeRideStat).where(EdgeRideStat.edge_id == w.edge_id)).first()
        if st is not None:
            st.jolt_events = list(st.jolt_events or []) + [{"t": w.t0, "peak": w.peak, "barrier_id": jolt_ids[-1], "ride_id": ride.id}]
            session.add(st)
    for eid in touched:
        st = session.exec(select(EdgeRideStat).where(EdgeRideStat.edge_id == eid)).first()
        stats_out.append({"edge_id": eid, "roughness_index": st.roughness_index, "n_windows": st.n_windows,
                          "verified_by_wheels": st.verified_by_wheels})
    ride.status = "processed"
    ride.n_samples = len(samples)
    duration = (samples[-1].t - samples[0].t) if samples else 0.0
    summary = {"id": ride.id, "status": ride.status, "duration_s": round(duration, 1), "n_samples": len(samples),
               "n_windows": len(windows), "n_matched_windows": sum(1 for w in windows if w.edge_id is not None),
               "edges_traversed": len(touched), "edges_verified_by_wheels": len(verified), "jolts": len(set(jolt_ids)),
               "verified_edge_ids": sorted(verified), "jolt_barrier_ids": jolt_ids, "roughness": stats_out,
               "synthetic": ride.synthetic}
    ride.summary = summary
    session.add(ride)
    session.commit()
    log.info("ride %s: %s", ride.id, {k: v for k, v in summary.items() if k not in ("roughness", "verified_edge_ids")})
    return summary


# ----------------------------------------------------------------------------- synthetic demo ride


def synthetic_ride_samples(edge_geoms: list[LineString], cfg: dict[str, Any], jolt_at_fraction: float | None = 0.5,
                           seed: int | None = None) -> list[Sample]:
    """Samples for a ride along the given metric geometries in order: 50 Hz accelerometer with
    gravity on az, small smooth noise, one jolt (if requested) and 1 Hz GPS fixes. SYNTHETIC."""
    import random

    d = cfg["demo_ride"]
    rng = random.Random(seed if seed is not None else int(d["random_seed"]))
    speed, hz = float(d["speed_m_s"]), float(cfg["accel_hz"])
    coords: list[tuple[float, float]] = []
    for g in edge_geoms:
        pts = list(g.coords)
        if coords and math.hypot(pts[0][0] - coords[-1][0], pts[0][1] - coords[-1][1]) > math.hypot(pts[-1][0] - coords[-1][0], pts[-1][1] - coords[-1][1]):
            pts = pts[::-1]
        coords.extend(pts if not coords else pts[1:] if math.hypot(pts[0][0] - coords[-1][0], pts[0][1] - coords[-1][1]) < 0.01 else pts)
    path = LineString(coords)
    total = path.length
    duration = total / speed
    jolt_t = duration * jolt_at_fraction if jolt_at_fraction is not None else None
    samples: list[Sample] = []
    n = int(duration * hz)
    smooth = float(d["smooth_rms_m_s2"])
    for i in range(n):
        t = i / hz
        az = 9.81 + rng.gauss(0.0, smooth)
        if jolt_t is not None and abs(t - jolt_t) < 0.1:
            az += float(d["jolt_peak_m_s2"]) * (1.0 if int(t * hz) % 2 == 0 else -0.6)
        samples.append(Sample(t, rng.gauss(0, 0.2), rng.gauss(0, 0.2), az))
    for k in range(int(duration) + 1):
        p = path.interpolate(min(k * speed, total))
        lon, lat = xy_to_lonlat(p.x, p.y)
        samples.append(Sample(float(k), lat=lat, lon=lon, gps_accuracy_m=5.0, speed_m_s=speed))
    samples.sort(key=lambda s: s.t)
    return samples


def demo_ride_edges(session: Session, max_edges: int = 12, min_length_m: float = 120.0) -> list[FootpathEdge]:
    """Edges for the demo ride: a contiguous run of UNKNOWN edges touching Riya's route (so the
    replay visibly turns them "verified by wheels"); falls back to the route itself."""
    import networkx as nx

    from api.models import DemoRoute
    from pipeline.graph.osm import load_nx_from_db

    route = session.get(DemoRoute, "riya")
    if route is None:
        return []
    G = load_nx_from_db(session)
    path = nx.shortest_path(G, route.origin_node_id, route.destination_node_id, weight="length_m")
    edges = {e.id: e for e in session.exec(select(FootpathEdge)).all()}
    seq = [edges[G[a][b]["id"]] for a, b in itertools.pairwise(path)]
    unknown_on_path = [i for i, e in enumerate(seq) if e.state == "unknown"]
    if unknown_on_path:
        start = max(0, unknown_on_path[0] - 2)
        return seq[start:start + max_edges]
    # walk away from a route node along unknown edges, longest run wins
    best: list[FootpathEdge] = []
    for node in path:
        for nb in G.neighbors(node):
            eid = G[node][nb]["id"]
            if edges[eid].state != "unknown":
                continue
            run, used, cur = [edges[eid]], {eid}, nb
            while len(run) < max_edges:
                nxt = [(G[cur][m]["id"], m) for m in G.neighbors(cur) if G[cur][m]["id"] not in used and edges[G[cur][m]["id"]].state == "unknown"]
                if not nxt:
                    break
                eid2, m = max(nxt, key=lambda t: edges[t[0]].length_m)
                run.append(edges[eid2]); used.add(eid2); cur = m
            if sum(e.length_m for e in run) > sum(e.length_m for e in best):
                best = run
            if sum(e.length_m for e in best) >= min_length_m and len(best) >= 3:
                break
        if sum(e.length_m for e in best) >= min_length_m and len(best) >= 3:
            break
    return best if best else seq[:max_edges]
