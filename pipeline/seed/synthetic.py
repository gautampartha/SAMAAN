"""`make seed`: synthetic barriers + coverage on the real OSM graph of the zone.

EVERYTHING this module writes is flagged `synthetic=True` (and edge states
`state_synthetic=True`). Eval scripts must exclude it. It exists so the API and UI
never wait for the ML pipeline (plan section 7, P0).

Also builds the demo trip (Riya from Karkarduma metro, ~800 m) with the three story
barriers placed on the shortest walking path.
"""
from __future__ import annotations

import itertools
import logging
import random
from datetime import UTC, datetime, timedelta
from typing import Any

import networkx as nx
from shapely.geometry import LineString, Point
from shapely.ops import linemerge
from sqlmodel import Session, delete, select

from api.db import init_db
from api.models import Anchor, Barrier, Coverage, DemoRoute, FootpathEdge
from common import config
from common.crs import to_wgs84
from common.state import compute_edge_state
from pipeline.graph.osm import load_nx_from_db, write_meta

log = logging.getLogger(__name__)

# Tag pools per class (ids from config/taxonomy.yaml `tags`).
TAG_POOL: dict[str, list[str]] = {
    "curb_ramp": ["no_landing", "too_steep", "narrow"],
    "steps_or_high_kerb": ["steps", "high_kerb", "no_ramp", "two_steps"],
    "broken_surface": ["cracks", "uneven", "tree_root", "construction_debris"],
    "open_drain": ["uneven"],
    "fixed_obstacle": ["pole", "transformer_box", "narrow"],
    "parked_vehicle": ["two_wheeler", "parked_car", "auto_rickshaw"],
    "vendor_encroachment": ["cart", "stall"],
    "bike_barrier": ["chicane", "bollard", "narrow"],
}
# Lower weight for the positive class so most seeded rows are barriers.
CLASS_WEIGHTS: dict[str, float] = {"curb_ramp": 0.5}


def time_profile_for(class_id: str, rng: random.Random) -> list[float] | None:
    """24 hourly P(present) values for temporary classes. Synthetic shape, not measured."""
    if class_id == "parked_vehicle":
        base = [0.25 if h < 8 or h > 21 else 0.7 for h in range(24)]
    elif class_id == "vendor_encroachment":
        base = [0.05 if h < 9 or h > 21 else 0.8 for h in range(24)]
    else:
        return None
    return [round(min(1.0, max(0.0, p + rng.uniform(-0.08, 0.08))), 2) for p in base]


def _oriented(geom: LineString, from_xy: tuple[float, float]) -> tuple[LineString, bool]:
    """Orient an edge geometry to start near `from_xy`. Returns (geometry, reversed)."""
    x0, y0 = geom.coords[0]
    x1, y1 = geom.coords[-1]
    d_start = (x0 - from_xy[0]) ** 2 + (y0 - from_xy[1]) ** 2
    d_end = (x1 - from_xy[0]) ** 2 + (y1 - from_xy[1]) ** 2
    if d_end < d_start:
        return LineString(list(geom.coords)[::-1]), True
    return geom, False


def _row_oriented_position(edge: FootpathEdge, geom_m: LineString, pt: Point) -> float:
    """position_along_edge_m in the stored (u->v) orientation of the edge row."""
    return float(LineString(geom_m.coords).project(pt))


def pick_destination(G: nx.Graph, origin: int, target_m: float, tol_m: float) -> tuple[int, float]:
    dist = nx.single_source_dijkstra_path_length(G, origin, weight="length_m")
    candidates = [n for n, d in dist.items() if abs(d - target_m) <= tol_m and n != origin]
    pool = candidates or [n for n in dist if n != origin]
    if not pool:
        raise RuntimeError("origin node has no reachable neighbours")
    node = min(pool, key=lambda n: (abs(dist[n] - target_m), n))
    return node, float(dist[node])


def build_demo(session: Session, G: nx.Graph, zone_cfg: dict[str, Any], edges_by_id: dict[int, FootpathEdge],
               now: datetime) -> tuple[list[Barrier], set[int], DemoRoute]:
    demo = zone_cfg["demo"]["riya"]
    anchor = session.get(Anchor, demo["origin_anchor"])
    if anchor is None or anchor.node_id is None:
        raise RuntimeError(f"anchor {demo['origin_anchor']} missing or not snapped; run `make graph` first")
    origin = anchor.node_id
    dest, _dist_m = pick_destination(G, origin, demo["target_network_distance_m"], demo["target_tolerance_m"])
    path = nx.shortest_path(G, origin, dest, weight="length_m")

    # Walk the path, orienting each edge geometry along the direction of travel.
    pieces: list[tuple[FootpathEdge, LineString, bool, float]] = []  # (edge, oriented geom, reversed, cum_start)
    cum = 0.0
    parts: list[LineString] = []
    for a, b in itertools.pairwise(path):
        data = G[a][b]
        edge = edges_by_id[data["id"]]
        geom, rev = _oriented(data["geometry"], (G.nodes[a]["x"], G.nodes[a]["y"]))
        pieces.append((edge, geom, rev, cum))
        parts.append(geom)
        cum += geom.length
    total = cum
    merged = linemerge(parts) if len(parts) > 1 else parts[0]
    if merged.geom_type != "LineString":
        merged = LineString([c for p in parts for c in p.coords])

    barriers: list[Barrier] = []
    fractions = [0.25, 0.55, 0.80][: len(demo["barriers"])]
    for frac, spec in zip(fractions, demo["barriers"]):
        target = frac * total
        edge, geom, rev, start = next(
            (p for p in pieces if p[3] <= target <= p[3] + p[1].length), pieces[-1]
        )
        offset = min(max(target - start, 0.0), geom.length)
        pt = geom.interpolate(offset)
        pos = (geom.length - offset) if rev else offset
        lon, lat = to_wgs84(pt).coords[0]
        barriers.append(Barrier(
            class_id=spec["class"], severity=int(spec["severity"]), tags=list(spec.get("tags", [])),
            edge_id=edge.id, side="none", position_along_edge_m=float(pos), lat=float(lat), lon=float(lon),
            permanent=bool(spec.get("permanent", True)),
            time_profile=None if spec.get("permanent", True) else time_profile_for(spec["class"], random.Random(1)),
            status="active", confidence=0.9, sources=["seed:riya_demo"],
            note="Riya demo story barrier", created_at=now, last_seen_at=now, synthetic=True,
        ))
    route = DemoRoute(
        id="riya", label_en=demo["destination_label"]["en"], label_hi=demo["destination_label"]["hi"],
        origin_node_id=origin, destination_node_id=dest, origin_anchor_id=anchor.id,
        path_wkt=to_wgs84(merged).wkt, length_m=float(total), synthetic=True,
    )
    log.info("demo trip: origin node %s -> dest node %s, %.0f m over %d edges", origin, dest, total, len(pieces))
    return barriers, {p[0].id for p in pieces}, route


def seed(session: Session, zone_cfg: dict[str, Any] | None = None, profiles_cfg: dict[str, Any] | None = None,
         taxonomy_cfg: dict[str, Any] | None = None, pipeline_cfg: dict[str, Any] | None = None,
         now: datetime | None = None) -> dict[str, Any]:
    zone_cfg = zone_cfg or config.zone()
    profiles_cfg = profiles_cfg or config.profiles()
    taxonomy_cfg = taxonomy_cfg or config.taxonomy()
    pipeline_cfg = pipeline_cfg or config.pipeline()
    now = now or datetime.now(UTC)
    scfg = pipeline_cfg["seed"]
    rng = random.Random(int(scfg["random_seed"]))

    # Remove earlier synthetic rows; reset seeded edge states.
    session.exec(delete(Barrier).where(Barrier.synthetic == True))
    session.exec(delete(Coverage).where(Coverage.synthetic == True))
    session.exec(delete(DemoRoute))
    edges = session.exec(select(FootpathEdge)).all()
    if not edges:
        raise RuntimeError("no edges in DB; run `make graph` first")
    for e in edges:
        if e.state_synthetic:
            e.state, e.state_confidence, e.state_synthetic = "unknown", 0.0, False
            e.last_observed_at, e.observed_by = None, None
    session.flush()
    edges_by_id = {e.id: e for e in edges}
    G = load_nx_from_db(session)

    barriers, demo_edge_ids, route = build_demo(session, G, zone_cfg, edges_by_id, now)

    # Random barriers on non-demo edges.
    classes = config.detector_class_ids(taxonomy_cfg)
    weights = [CLASS_WEIGHTS.get(c, 1.0) for c in classes]
    sev_w = scfg["severity_weights"]
    sev_levels, sev_weights = list(sev_w.keys()), list(sev_w.values())
    temporary = config.temporary_classes(taxonomy_cfg)
    pool = [e for e in edges if e.id not in demo_edge_ids and e.length_m > 5]
    for e in rng.sample(pool, k=min(int(scfg["n_random_barriers"]), len(pool))):
        from shapely import wkt as _wkt

        geom_m = _wkt.loads(e.geom_m_wkt)
        cls = rng.choices(classes, weights=weights, k=1)[0]
        sev = 1 if cls == "curb_ramp" else int(rng.choices(sev_levels, weights=sev_weights, k=1)[0])
        pos = rng.uniform(0.1, 0.9) * geom_m.length
        pt = geom_m.interpolate(pos)
        lon, lat = to_wgs84(pt).coords[0]
        is_temp = cls in temporary
        days_ago = rng.uniform(0, 30)
        barriers.append(Barrier(
            class_id=cls, severity=sev, tags=[rng.choice(TAG_POOL.get(cls, ["uneven"]))],
            edge_id=e.id, side="none", position_along_edge_m=float(pos), lat=float(lat), lon=float(lon),
            permanent=not is_temp, time_profile=time_profile_for(cls, rng) if is_temp else None,
            status="active", confidence=round(rng.uniform(0.5, 0.95), 2), sources=["seed:random"],
            created_at=now - timedelta(days=days_ago), last_seen_at=now - timedelta(days=days_ago),
            synthetic=True,
        ))
    for b in barriers:
        session.add(b)
    session.flush()

    # Coverage: demo path + barrier edges always observed; then random edges up to the fraction.
    observed = set(demo_edge_ids) | {b.edge_id for b in barriers}
    want = round(scfg["observed_edge_fraction"] * len(edges))
    rest = [e.id for e in edges if e.id not in observed]
    rng.shuffle(rest)
    observed |= set(rest[: max(0, want - len(observed))])
    k_min = int(pipeline_cfg["coverage"]["min_images_k"])
    for e in edges:
        obs = e.id in observed
        last = (now - timedelta(days=rng.uniform(0, 30))) if obs else None
        session.add(Coverage(edge_id=e.id, side="none", observed=obs, n_images=rng.randint(k_min, k_min + 3) if obs else 0,
                             last_observed_at=last, source="seed", synthetic=True))
        e.last_observed_at, e.observed_by = last, ("image" if obs else None)
    session.flush()

    # Segment state (plan 6.5).
    by_edge: dict[int, list[dict[str, Any]]] = {}
    for b in barriers:
        by_edge.setdefault(b.edge_id, []).append({"class": b.class_id, "severity": b.severity,
                                                  "status": b.status, "confidence": b.confidence})
    staleness = int(pipeline_cfg["state"]["staleness_days_permanent"])
    counts = {"clear": 0, "blocked": 0, "unknown": 0}
    for e in edges:
        state, conf = compute_edge_state(by_edge.get(e.id, []), e.id in observed, e.last_observed_at,
                                         profiles_cfg, staleness, now)
        e.state, e.state_confidence, e.state_synthetic = state, conf, True
        counts[state] += 1
    session.add(route)
    session.commit()
    write_meta(session, seeded_at=now.isoformat(), random_seed=scfg["random_seed"], synthetic="true",
               seed_note="All Barrier/Coverage/DemoRoute rows and edge states are synthetic; exclude from eval.")
    return {"edges": len(edges), "barriers": len(barriers), "observed_edges": len(observed),
            "states": counts, "demo_length_m": round(route.length_m, 1), "demo_edges": len(demo_edge_ids)}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    engine = init_db()
    with Session(engine) as session:
        summary = seed(session)
    print("seeded (synthetic=true):", summary)


if __name__ == "__main__":
    main()
