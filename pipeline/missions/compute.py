"""Missions (plan 6.9): which unknown footpath stretches matter most.

Sample N random origin-destination pairs inside the zone plus every anchor paired with random
destinations, route each in `samaan` mode and in `shortest` mode. An unknown edge scores one
count per route that USES it (samaan) or DETOURS around it (on the shortest path but avoided
by samaan). priority = count × length. Unknown edges with priority > 0 are merged into
connected stretches; the top N become Mission rows.
"""
from __future__ import annotations

import itertools
import logging
import random
from datetime import UTC, datetime
from typing import Any

import networkx as nx
from shapely import wkt
from shapely.geometry import LineString
from shapely.ops import linemerge
from sqlmodel import Session, delete, select

from api.models import Anchor, FootpathEdge, Mission, RoadCentreline
from api.services.routing import RoutingContext, build_context, find_path
from common import config
from common.crs import to_wgs84

log = logging.getLogger(__name__)


def sample_pairs(ctx: RoutingContext, anchors: list[int], n: int, min_m: float, max_m: float, rng: random.Random) -> list[tuple[int, int]]:
    nodes = list(ctx.node_xy)
    pairs: list[tuple[int, int]] = []
    tries = 0
    while len(pairs) < n and tries < n * 20:
        tries += 1
        a, b = rng.choice(nodes), rng.choice(nodes)
        (x0, y0), (x1, y1) = ctx.node_xy[a], ctx.node_xy[b]
        d = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        if a != b and min_m <= d <= max_m:
            pairs.append((a, b))
    for anc in anchors:
        for _ in range(max(1, n // max(len(anchors), 1) // 5)):
            b = rng.choice(nodes)
            if b != anc:
                pairs.append((anc, b))
    return pairs


def compute_missions(session: Session, pipeline_cfg: dict[str, Any] | None = None, n_pairs: int | None = None,
                     now: datetime | None = None) -> dict[str, Any]:
    pipeline_cfg = pipeline_cfg or config.pipeline()
    mcfg = pipeline_cfg["missions"]
    now = now or datetime.now(UTC)
    ctx = build_context(session)
    rng = random.Random(int(mcfg["random_seed"]))
    anchors = [a.node_id for a in session.exec(select(Anchor)).all() if a.node_id in ctx.node_xy]
    pairs = sample_pairs(ctx, anchors, int(n_pairs or mcfg["random_od_pairs"]), float(mcfg["min_od_distance_m"]),
                         float(mcfg["max_od_distance_m"]), rng)
    profile, risk, hour = mcfg["profile"], mcfg["risk"], now.hour
    counts: dict[int, int] = {}
    routed = 0
    for a, b in pairs:
        samaan = find_path(ctx, a, b, profile, "samaan", risk, hour)
        shortest = find_path(ctx, a, b, profile, "shortest", risk, hour)
        if not samaan and not shortest:
            continue
        routed += 1
        used = {ctx.graph[u][v]["id"] for u, v in itertools.pairwise(samaan)} if samaan else set()
        short = {ctx.graph[u][v]["id"] for u, v in itertools.pairwise(shortest)} if shortest else set()
        for eid in used | (short - used):  # used, or detoured around
            if ctx.edges[eid].state == "unknown":
                counts[eid] = counts.get(eid, 0) + 1
    # merge scored unknown edges into connected stretches
    H = nx.Graph()
    for eid, c in counts.items():
        e = ctx.edges[eid]
        H.add_edge(e.u, e.v, id=eid, priority=c * e.length_m, n=c, length=e.length_m)
    stretches = []
    for comp in nx.connected_components(H):
        sub = H.subgraph(comp)
        eids = [d["id"] for _, _, d in sub.edges(data=True)]
        geoms = [ctx.edges[i].geometry for i in eids]
        merged = linemerge(geoms) if len(geoms) > 1 else geoms[0]
        if merged.geom_type != "LineString":
            merged = LineString([c for g in geoms for c in g.coords])
        stretches.append({"edge_ids": eids, "priority": sum(d["priority"] for _, _, d in sub.edges(data=True)),
                          "n_routes": max(d["n"] for _, _, d in sub.edges(data=True)),
                          "length_m": sum(d["length"] for _, _, d in sub.edges(data=True)), "geometry": merged})
    stretches.sort(key=lambda s: -s["priority"])
    roads = session.exec(select(RoadCentreline)).all()
    road_geoms = [(r, wkt.loads(r.geom_m_wkt)) for r in roads if r.name]
    session.exec(delete(Mission))
    top = stretches[: int(mcfg["top_n"])]
    for rank, s in enumerate(top, start=1):
        name = None
        if road_geoms:
            r, _ = min(road_geoms, key=lambda rg: rg[1].distance(s["geometry"]))
            name = r.name
        session.add(Mission(rank=rank, priority=round(s["priority"], 1), n_routes=int(s["n_routes"]), length_m=round(s["length_m"], 1),
                            edge_ids=s["edge_ids"], geom_wkt=to_wgs84(s["geometry"]).wkt, name_en=name, name_hi=None,
                            status="open", computed_at=now, synthetic=any(ctx.edges[i].state == "unknown" and False for i in s["edge_ids"])))
    session.commit()
    summary = {"pairs_sampled": len(pairs), "routes_computed": routed, "unknown_edges_scored": len(counts),
               "stretches": len(stretches), "missions": len(top)}
    log.info("missions: %s", summary)
    return summary


def refresh_status(session: Session) -> None:
    """A mission is done when none of its edges is unknown any more."""
    edges = {e.id: e for e in session.exec(select(FootpathEdge)).all()}
    for m in session.exec(select(Mission)).all():
        done = all(edges[i].state != "unknown" for i in m.edge_ids if i in edges)
        new = "done" if done else "open"
        if new != m.status:
            m.status = new
            session.add(m)
    session.commit()
