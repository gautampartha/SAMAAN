"""Reach Gap (plan 6.7): reachable footpath length from an anchor within a time cutoff, per
profile, the gap to a walker, a concave-hull blob for display, and greedy fix ranking.

Reach uses the P5 cost model: the walker baseline runs in `naive_accessible` mode (no unknown
penalty; walker rules are empty), the target profile in `samaan` mode with the chosen risk.
Partial edges count: if only one end is reached, the fraction of the edge that fits in the
remaining time is added. Fixing a barrier = removing it from the cost model.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

import networkx as nx
import shapely
from shapely.geometry import MultiPoint, mapping

from api.services.routing import RoutingContext, edge_cost
from common import config
from common.crs import to_wgs84


@dataclass
class ReachResult:
    profile: str
    reach_m: float
    edge_ids: list[int]
    edge_fraction: dict[int, float] = field(default_factory=dict)
    hull: dict[str, Any] | None = None

    @property
    def reach_km(self) -> float:
        return round(self.reach_m / 1000.0, 3)

    def to_dict(self) -> dict[str, Any]:
        return {"profile": self.profile, "reach_km": self.reach_km, "n_edges": len(self.edge_ids), "hull": self.hull,
                "edge_ids": self.edge_ids}


def without_barriers(ctx: RoutingContext, fixed: set[int]) -> RoutingContext:
    """A context view with the given barriers treated as fixed (removed from costs)."""
    if not fixed:
        return ctx
    bbe = {eid: [b for b in bs if b.id not in fixed] for eid, bs in ctx.barriers_by_edge.items()}
    return replace(ctx, barriers_by_edge={k: v for k, v in bbe.items() if v})


def reach(ctx: RoutingContext, anchor_node: int, profile: str, cutoff_s: float, mode: str, risk: str, hour: int,
          fixed: set[int] | None = None, with_hull: bool = True) -> ReachResult:
    c = without_barriers(ctx, fixed or set())

    def weight(u: int, v: int, d: dict[str, Any]) -> float | None:
        return edge_cost(c, c.edges[d["id"]], profile, mode, risk, hour)

    dist = nx.single_source_dijkstra_path_length(c.graph, anchor_node, cutoff=cutoff_s, weight=weight)
    total = 0.0
    edge_ids: list[int] = []
    fractions: dict[int, float] = {}
    for u, v, d in c.graph.edges(data=True):
        eid = d["id"]
        e = c.edges[eid]
        cost = edge_cost(c, e, profile, mode, risk, hour)
        if cost is None:
            continue
        du, dv = dist.get(u), dist.get(v)
        if du is None and dv is None:
            continue
        if du is not None and dv is not None:
            frac = 1.0
        else:
            start = du if du is not None else dv
            frac = min(1.0, max(0.0, (cutoff_s - start) / cost)) if cost > 0 else 1.0
        if frac <= 0:
            continue
        total += frac * e.length_m
        edge_ids.append(eid)
        fractions[eid] = round(frac, 3)
    res = ReachResult(profile, total, edge_ids, fractions)
    if with_hull:
        res.hull = hull_for(ctx, edge_ids, fractions)
    return res


def hull_for(ctx: RoutingContext, edge_ids: list[int], fractions: dict[int, float]) -> dict[str, Any] | None:
    pts = []
    for eid in edge_ids:
        g = ctx.edges[eid].geometry
        f = fractions.get(eid, 1.0)
        n = max(2, int(g.length // 10) + 2)
        for i in range(n):
            t = f * i / (n - 1)
            p = g.interpolate(t, normalized=True)
            pts.append((p.x, p.y))
    if len(pts) < 3:
        return None
    ratio = float(config.pipeline()["reach"].get("hull_concave_ratio", 0.35))
    hull = shapely.concave_hull(MultiPoint(pts), ratio=ratio)
    if hull.is_empty or hull.geom_type not in ("Polygon", "MultiPolygon"):
        hull = MultiPoint(pts).convex_hull
        if hull.geom_type != "Polygon":
            return None
    return mapping(to_wgs84(hull.buffer(3.0)))


def fix_candidates(ctx: RoutingContext, walker: ReachResult, profile: str, max_candidates: int) -> list[Any]:
    """Active barriers on edges inside the walker's reach that cost the target profile something."""
    rules = ctx.profiles_cfg["profiles"][profile].get("rules", {})
    out = []
    for eid in walker.edge_ids:
        for b in ctx.barriers_by_edge.get(eid, []):
            rule = rules.get(b.class_id)
            if not rule:
                continue
            thr = rule.get("impassable_at_or_above")
            penal = any(int(k) <= b.severity for k in (rule.get("penalty_seconds_by_severity") or {}))
            if (thr is not None and b.severity >= thr) or penal:
                out.append(b)
    # most severe first; cap the search
    out.sort(key=lambda b: (-b.severity, b.id))
    return out[:max_candidates]


def rank_fixes(ctx: RoutingContext, anchor_node: int, profile: str, cutoff_s: float, risk: str, hour: int,
               walker: ReachResult, base: ReachResult, k: int, max_candidates: int) -> list[dict[str, Any]]:
    costs = config.fix_costs()["costs"]
    candidates = fix_candidates(ctx, walker, profile, max_candidates)
    chosen: set[int] = set()
    current = base.reach_m
    ranked: list[dict[str, Any]] = []
    for rank in range(1, k + 1):
        best, best_gain, best_res = None, 0.0, None
        for b in candidates:
            if b.id in chosen:
                continue
            r = reach(ctx, anchor_node, profile, cutoff_s, "samaan", risk, hour, chosen | {b.id}, with_hull=False)
            gain = r.reach_m - current
            if gain > best_gain + 1e-6:
                best, best_gain, best_res = b, gain, r
        if best is None:
            break
        chosen.add(best.id)
        current = best_res.reach_m
        cost = costs.get(best.class_id, {})
        cmin, cmax = cost.get("min"), cost.get("max")
        mid = (float(cmin) + float(cmax)) / 2 if cmin is not None and cmax is not None else None
        ranked.append({
            "rank": rank,
            "barrier": {"id": best.id, "class": best.class_id, "name_en": best.name.get("en", best.class_id),
                        "name_hi": best.name.get("hi", best.class_id), "severity": best.severity, "lat": best.lat, "lon": best.lon,
                        "edge_id": next((eid for eid, bs in ctx.barriers_by_edge.items() if best in bs), None),
                        "permanent": best.permanent, "synthetic": best.synthetic},
            "gain_km": round(best_gain / 1000.0, 3), "cumulative_reach_km": round(current / 1000.0, 3),
            "cost_lakh_min": cmin, "cost_lakh_max": cmax,
            "gain_km_per_lakh": round(best_gain / 1000.0 / mid, 3) if mid else None,
            "cost_is_estimate": True, "cost_source": cost.get("source", "TODO: estimate"),
        })
    return ranked


def reach_gap(ctx: RoutingContext, anchor_node: int, profile: str, cutoff_min: float, risk: str, hour: int,
              fixed: set[int] | None = None) -> dict[str, Any]:
    rcfg = config.pipeline()["reach"]
    cutoff_s = cutoff_min * 60.0
    walker = reach(ctx, anchor_node, "walker", cutoff_s, rcfg.get("walker_mode", "naive_accessible"), risk, hour)
    target = reach(ctx, anchor_node, profile, cutoff_s, "samaan", risk, hour)
    fixes = rank_fixes(ctx, anchor_node, profile, cutoff_s, risk, hour, walker, target, int(rcfg["fix_ranking_k"]),
                       int(rcfg.get("max_fix_candidates", 60)))
    out: dict[str, Any] = {
        "cutoff_min": cutoff_min, "risk": risk, "profile": profile,
        "walker": walker.to_dict(), "target": target.to_dict(),
        "gap_km": round((walker.reach_m - target.reach_m) / 1000.0, 3),
        "ratio": round(target.reach_m / walker.reach_m, 3) if walker.reach_m > 0 else None,
        "fixes": fixes, "simulated": None, "simulated_gap_km": None,
    }
    if fixed:
        sim = reach(ctx, anchor_node, profile, cutoff_s, "samaan", risk, hour, fixed)
        out["simulated"] = sim.to_dict()
        out["simulated_gap_km"] = round((walker.reach_m - sim.reach_m) / 1000.0, 3)
        out["simulated_fixed_ids"] = sorted(fixed)
    return out
