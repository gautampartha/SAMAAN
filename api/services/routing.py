"""Routing engine (plan 6.6): per-profile edge costs, three modes, A*, verified %, unknown stretches.

The RoutingContext is built from the DB at startup and refreshed after coverage/barrier changes.
Costs are in seconds. Edges a profile cannot use return None from the weight function, which
removes them for that search.
"""
from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import networkx as nx
from shapely import wkt
from shapely.geometry import LineString, Point
from shapely.ops import linemerge
from sqlmodel import Session, select

from api.models import Barrier, Detection, FootpathEdge, FootpathNode
from common import config
from common.crs import lonlat_to_xy, to_wgs84

MODES = ("shortest", "naive_accessible", "samaan")


@dataclass
class EdgeInfo:
    id: int
    u: int
    v: int
    length_m: float
    kind: str
    side: str
    state: str
    geometry: LineString
    signal: bool | None = None
    kerb_ramp_start: bool | None = None
    kerb_ramp_end: bool | None = None


@dataclass
class BarrierInfo:
    id: int
    class_id: str
    severity: int
    permanent: bool
    time_profile: list[float] | None
    lat: float
    lon: float
    confidence: float
    synthetic: bool
    sources: list[str] = field(default_factory=list)
    photo_image_ids: list[int] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    name: dict[str, str] = field(default_factory=dict)


@dataclass
class RoutingContext:
    graph: nx.Graph
    edges: dict[int, EdgeInfo]
    barriers_by_edge: dict[int, list[BarrierInfo]]
    node_xy: dict[int, tuple[float, float]]
    profiles_cfg: dict[str, Any]
    pipeline_cfg: dict[str, Any]


def build_context(session: Session, profiles_cfg: dict[str, Any] | None = None, pipeline_cfg: dict[str, Any] | None = None) -> RoutingContext:
    profiles_cfg = profiles_cfg or config.profiles()
    pipeline_cfg = pipeline_cfg or config.pipeline()
    names = config.class_names()
    G = nx.Graph()
    node_xy: dict[int, tuple[float, float]] = {}
    for n in session.exec(select(FootpathNode)).all():
        G.add_node(n.id, x=n.x, y=n.y, lat=n.lat, lon=n.lon)
        node_xy[n.id] = (n.x, n.y)
    edges: dict[int, EdgeInfo] = {}
    for e in session.exec(select(FootpathEdge)).all():
        info = EdgeInfo(e.id, e.u, e.v, e.length_m, e.kind, e.side, e.state, wkt.loads(e.geom_m_wkt), e.signal,
                        e.kerb_ramp_start, e.kerb_ramp_end)
        edges[e.id] = info
        if G.has_edge(e.u, e.v) and edges[G[e.u][e.v]["id"]].length_m <= e.length_m:
            continue
        G.add_edge(e.u, e.v, id=e.id)
    det_image = {d.id: d.image_id for d in session.exec(select(Detection)).all()}
    barriers_by_edge: dict[int, list[BarrierInfo]] = {}
    for b in session.exec(select(Barrier).where(Barrier.status == "active")).all():
        photos = [det_image[int(s.split(":", 1)[1])] for s in (b.sources or [])
                  if s.startswith("detection:") and s.split(":", 1)[1].isdigit() and int(s.split(":", 1)[1]) in det_image]
        if b.sources:
            photos += [int(s.split(":", 1)[1]) for s in b.sources if s.startswith("image:") and s.split(":", 1)[1].isdigit()]
        barriers_by_edge.setdefault(b.edge_id, []).append(BarrierInfo(
            b.id, b.class_id, b.severity, b.permanent, b.time_profile, b.lat, b.lon, b.confidence, b.synthetic,
            list(b.sources or []), sorted(set(photos)), list(b.tags or []), names.get(b.class_id, {})))
    return RoutingContext(G, edges, barriers_by_edge, node_xy, profiles_cfg, pipeline_cfg)


# ----------------------------------------------------------------------------- costs


def penalty_for_severity(rule: dict[str, Any], severity: int) -> float:
    table = {int(k): float(v) for k, v in (rule.get("penalty_seconds_by_severity") or {}).items()}
    if not table:
        return 0.0
    below = [k for k in table if k <= severity]
    return table[max(below)] if below else table[min(table)]


def barrier_cost(b: BarrierInfo, rules: dict[str, Any], hour: int, temp_threshold: float) -> float | None:
    """Seconds added by one barrier for this profile, or None when impassable."""
    rule = rules.get(b.class_id)
    if not rule:
        return 0.0
    p = 1.0
    if not b.permanent and b.time_profile:
        p = float(b.time_profile[hour % 24])
    threshold = rule.get("impassable_at_or_above")
    impassable = threshold is not None and b.severity >= threshold
    if impassable:
        if b.permanent or p >= temp_threshold:
            return None
        return penalty_for_severity(rule, b.severity) * p if penalty_for_severity(rule, b.severity) else 60.0 * p
    return penalty_for_severity(rule, b.severity) * p


def edge_cost(ctx: RoutingContext, edge: EdgeInfo, profile: str, mode: str, risk: str, hour: int) -> float | None:
    """Plan 6.6 edge cost in seconds, or None if the edge is unusable for this profile/mode."""
    pcfg = ctx.profiles_cfg
    prof_id = "walker" if mode == "shortest" else profile
    prof = pcfg["profiles"][prof_id]
    speed = float(prof["speed_m_s"]["value"])
    cost = edge.length_m / speed
    if mode == "shortest":
        return cost
    kind_rules = (pcfg.get("edge_kind_rules") or {}).get(prof_id, {})
    kr = kind_rules.get(edge.kind)
    if kr:
        if kr.get("impassable"):
            return None
        cost *= float(kr.get("multiplier", 1.0))
        if edge.kind == "crossing":
            cost += float(kr.get("penalty_seconds_signalised" if edge.signal else "penalty_seconds_unsignalised", 0.0))
            if kr.get("kerb_ramp_missing_impassable") and (edge.kerb_ramp_start is False or edge.kerb_ramp_end is False):
                return None
        else:
            cost += float(kr.get("penalty_seconds", 0.0))
    temp_threshold = float(pcfg.get("temporary_impassable_probability", 0.6))
    for b in ctx.barriers_by_edge.get(edge.id, []):
        add = barrier_cost(b, prof.get("rules", {}), hour, temp_threshold)
        if add is None:
            return None
        cost += add
    if mode == "samaan" and edge.state == "unknown":
        cost *= float(pcfg["unknown_multiplier"][risk])
    return cost


# ----------------------------------------------------------------------------- search


def nearest_node(ctx: RoutingContext, lon: float, lat: float, max_m: float) -> tuple[int | None, float]:
    x, y = lonlat_to_xy(lon, lat)
    best, best_d = None, float("inf")
    for n, (nx_, ny_) in ctx.node_xy.items():
        d = (nx_ - x) ** 2 + (ny_ - y) ** 2
        if d < best_d:
            best, best_d = n, d
    dist = math.sqrt(best_d) if best is not None else float("inf")
    return (best, dist) if dist <= max_m else (None, dist)


def find_path(ctx: RoutingContext, origin: int, dest: int, profile: str, mode: str, risk: str, hour: int) -> list[int] | None:
    speed = float(ctx.profiles_cfg["profiles"]["walker" if mode == "shortest" else profile]["speed_m_s"]["value"])
    max_speed = max(float(p["speed_m_s"]["value"]) for p in ctx.profiles_cfg["profiles"].values())

    def weight(u: int, v: int, d: dict[str, Any]) -> float | None:
        return edge_cost(ctx, ctx.edges[d["id"]], profile, mode, risk, hour)

    def heuristic(a: int, b: int) -> float:  # admissible: straight line at the fastest speed, no penalties
        (x0, y0), (x1, y1) = ctx.node_xy[a], ctx.node_xy[b]
        return math.hypot(x1 - x0, y1 - y0) / max(max_speed, speed)

    try:
        return nx.astar_path(ctx.graph, origin, dest, heuristic=heuristic, weight=weight)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None


def _oriented(geom: LineString, start: tuple[float, float]) -> LineString:
    x0, y0 = geom.coords[0]
    x1, y1 = geom.coords[-1]
    if (x1 - start[0]) ** 2 + (y1 - start[1]) ** 2 < (x0 - start[0]) ** 2 + (y0 - start[1]) ** 2:
        return LineString(list(geom.coords)[::-1])
    return geom


def describe_route(ctx: RoutingContext, path: list[int], profile: str, mode: str, risk: str, hour: int) -> dict[str, Any]:
    pcfg = ctx.profiles_cfg
    edge_ids = [ctx.graph[a][b]["id"] for a, b in itertools.pairwise(path)]
    parts: list[LineString] = []
    total = clear_len = unknown_len = blocked_len = 0.0
    eta = 0.0
    barriers: list[dict[str, Any]] = []
    unknown_stretches: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    min_stretch = float(ctx.pipeline_cfg.get("routing", {}).get("unknown_stretch_min_m", 5))
    for (a, _b), eid in zip(itertools.pairwise(path), edge_ids, strict=False):
        e = ctx.edges[eid]
        geom = _oriented(e.geometry, ctx.node_xy[a])
        parts.append(geom)
        total += e.length_m
        c = edge_cost(ctx, e, profile, mode, risk, hour)
        eta += c if c is not None else e.length_m / float(pcfg["profiles"]["walker"]["speed_m_s"]["value"])
        if e.state == "clear":
            clear_len += e.length_m
        elif e.state == "blocked":
            blocked_len += e.length_m
        if e.state == "unknown":
            unknown_len += e.length_m
            if current is None:
                current = {"start": list(to_wgs84(Point(geom.coords[0])).coords[0]), "length_m": 0.0, "edge_ids": []}
            current["length_m"] += e.length_m
            current["edge_ids"].append(eid)
            current["end"] = list(to_wgs84(Point(geom.coords[-1])).coords[0])
        elif current is not None:
            if current["length_m"] >= min_stretch:
                unknown_stretches.append(current)
            current = None
        for b in ctx.barriers_by_edge.get(eid, []):
            # impassability is always judged for the SELECTED profile, also on the shortest route:
            # that is what shows a normal map sending a wheelchair user over steps
            rule = pcfg["profiles"][profile].get("rules", {}).get(b.class_id, {})
            thr = rule.get("impassable_at_or_above")
            barriers.append({
                "id": b.id, "class": b.class_id, "name_en": b.name.get("en", b.class_id), "name_hi": b.name.get("hi", b.class_id),
                "severity": b.severity, "permanent": b.permanent, "lat": b.lat, "lon": b.lon, "edge_id": eid,
                "confidence": b.confidence, "tags": b.tags, "synthetic": b.synthetic,
                "p_present": (b.time_profile[hour % 24] if (not b.permanent and b.time_profile) else 1.0),
                "impassable_for_profile": bool(thr is not None and b.severity >= thr),
                "photo_urls": [f"/images/{iid}/photo" for iid in b.photo_image_ids],
            })
    if current is not None and current["length_m"] >= min_stretch:
        unknown_stretches.append(current)
    for s in unknown_stretches:
        s["length_m"] = round(s["length_m"], 1)
    merged = linemerge(parts) if len(parts) > 1 else parts[0]
    if merged.geom_type != "LineString":
        merged = LineString([c for p in parts for c in p.coords])
    return {
        "mode": mode, "profile": "walker" if mode == "shortest" else profile, "risk": risk if mode == "samaan" else None,
        "geometry": {"type": "LineString", "coordinates": [list(c) for c in to_wgs84(merged).coords]},
        "length_m": round(total, 1), "eta_s": round(eta), "eta_min": round(eta / 60, 1),
        "n_edges": len(edge_ids), "edge_ids": edge_ids,
        "verified_pct": round(100.0 * clear_len / total, 1) if total else 0.0,
        "unknown_pct": round(100.0 * unknown_len / total, 1) if total else 0.0,
        "blocked_pct": round(100.0 * blocked_len / total, 1) if total else 0.0,
        "barriers": barriers, "n_barriers": len(barriers),
        "n_barriers_impassable": sum(1 for b in barriers if b["impassable_for_profile"]),
        "unknown_stretches": unknown_stretches, "n_unknown_stretches": len(unknown_stretches),
        "synthetic": any(b["synthetic"] for b in barriers) or any(ctx.edges[e].state != "unknown" for e in edge_ids) and _any_state_synthetic(ctx, edge_ids),
    }


def _any_state_synthetic(ctx: RoutingContext, edge_ids: list[int]) -> bool:
    # states carry a synthetic flag in the DB; the context does not keep it per edge, so the
    # endpoint adds the DB-level flag. Kept as a hook for the API layer.
    return False


def route_all_modes(ctx: RoutingContext, origin: int, dest: int, profile: str, risk: str, depart: datetime | None) -> dict[str, Any]:
    hour = (depart or datetime.now()).hour
    out: dict[str, Any] = {}
    for mode in MODES:
        path = find_path(ctx, origin, dest, profile, mode, risk, hour)
        out[mode] = describe_route(ctx, path, profile, mode, risk, hour) if path else None
    return {"profile": profile, "risk": risk, "departure_hour": hour, "origin_node": origin, "destination_node": dest,
            "routes": out}
