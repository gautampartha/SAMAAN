"""Routing engine on toy graphs (plan 6.6, rule 11.5)."""
from __future__ import annotations

import itertools
from datetime import datetime

import networkx as nx
import pytest
from shapely.geometry import LineString

from api.services.routing import (
    BarrierInfo,
    EdgeInfo,
    RoutingContext,
    barrier_cost,
    edge_cost,
    find_path,
    penalty_for_severity,
    route_all_modes,
)
from common import config

P = config.profiles()
PIPE = config.pipeline()
WALK = float(P["profiles"]["walker"]["speed_m_s"]["value"])
WC = float(P["profiles"]["wheelchair_manual"]["speed_m_s"]["value"])


def ctx_from(nodes: dict[int, tuple[float, float]], edges: list[tuple[int, int, int, str, str]],
             barriers: dict[int, list[BarrierInfo]] | None = None, profiles=None) -> RoutingContext:
    """edges: (edge id, u, v, kind, state)."""
    G = nx.Graph()
    for n, (x, y) in nodes.items():
        G.add_node(n, x=x, y=y)
    infos: dict[int, EdgeInfo] = {}
    for eid, u, v, kind, state in edges:
        geom = LineString([nodes[u], nodes[v]])
        infos[eid] = EdgeInfo(eid, u, v, geom.length, kind, "none", state, geom)
        G.add_edge(u, v, id=eid)
    return RoutingContext(G, infos, barriers or {}, dict(nodes), profiles or P, PIPE)


def barrier(bid: int, cls: str, sev: int, permanent: bool = True, profile: list[float] | None = None) -> BarrierInfo:
    return BarrierInfo(bid, cls, sev, permanent, profile, 0.0, 0.0, 0.9, False)


# Two ways from A(1) to D(4): short via B(2) [100 m + 100 m], long via C(3) [150 + 150 + 150].
NODES = {1: (0.0, 0.0), 2: (100.0, 0.0), 4: (200.0, 0.0), 3: (100.0, 150.0), 5: (0.0, 150.0)}
EDGES = [(10, 1, 2, "sidewalk", "clear"), (11, 2, 4, "sidewalk", "clear"),
         (20, 1, 5, "sidewalk", "clear"), (21, 5, 3, "sidewalk", "clear"), (22, 3, 4, "sidewalk", "clear")]


def test_penalty_lookup_uses_nearest_lower_severity():
    rule = {"penalty_seconds_by_severity": {1: 10, 3: 30}}
    assert penalty_for_severity(rule, 1) == 10 and penalty_for_severity(rule, 2) == 10
    assert penalty_for_severity(rule, 3) == 30 and penalty_for_severity(rule, 5) == 30
    assert penalty_for_severity({}, 4) == 0.0


def test_barrier_cost_permanent_and_temporary():
    rules = P["profiles"]["wheelchair_manual"]["rules"]
    assert barrier_cost(barrier(1, "steps_or_high_kerb", 4), rules, 12, 0.6) is None          # impassable
    assert barrier_cost(barrier(1, "steps_or_high_kerb", 1), rules, 12, 0.6) == 30.0          # penalty
    assert barrier_cost(barrier(1, "curb_ramp", 5), rules, 12, 0.6) == 0.0                    # positive class
    busy = [0.9] * 24
    quiet = [0.1] * 24
    assert barrier_cost(barrier(1, "parked_vehicle", 4, False, busy), rules, 12, 0.6) is None  # P >= threshold
    q = barrier_cost(barrier(1, "parked_vehicle", 4, False, quiet), rules, 12, 0.6)
    assert q is not None and 0 < q < 90                                                        # scaled penalty
    assert barrier_cost(barrier(1, "parked_vehicle", 3, False, busy), rules, 12, 0.6) == pytest.approx(90 * 0.9)


def test_shortest_ignores_barriers_but_wheelchair_detours():
    ctx = ctx_from(NODES, EDGES, {10: [barrier(1, "steps_or_high_kerb", 4)]})
    assert find_path(ctx, 1, 4, "wheelchair_manual", "shortest", "balanced", 12) == [1, 2, 4]
    assert find_path(ctx, 1, 4, "wheelchair_manual", "naive_accessible", "balanced", 12) == [1, 5, 3, 4]
    assert find_path(ctx, 1, 4, "wheelchair_manual", "samaan", "balanced", 12) == [1, 5, 3, 4]
    # a walker with a walking aid pays 10 s for a low kerb and still takes the short way
    ctx2 = ctx_from(NODES, EDGES, {10: [barrier(1, "steps_or_high_kerb", 1)]})
    assert find_path(ctx2, 1, 4, "elderly_walking_aid", "samaan", "balanced", 12) == [1, 2, 4]


def test_unknown_multiplier_separates_naive_and_samaan():
    edges = [(10, 1, 2, "sidewalk", "unknown"), (11, 2, 4, "sidewalk", "unknown"),
             (20, 1, 5, "sidewalk", "clear"), (21, 5, 3, "sidewalk", "clear"), (22, 3, 4, "sidewalk", "clear")]
    ctx = ctx_from(NODES, edges)
    assert find_path(ctx, 1, 4, "wheelchair_manual", "naive_accessible", "strict", 12) == [1, 2, 4]  # unknown = clear
    assert find_path(ctx, 1, 4, "wheelchair_manual", "samaan", "strict", 12) == [1, 5, 3, 4]        # x5 -> detour
    assert find_path(ctx, 1, 4, "wheelchair_manual", "samaan", "relaxed", 12) == [1, 2, 4]          # x1 -> short
    # balanced x1.5: 200 m * 1.5 = 300 m-equivalent < 430 m detour -> still short
    assert find_path(ctx, 1, 4, "wheelchair_manual", "samaan", "balanced", 12) == [1, 2, 4]
    res = route_all_modes(ctx, 1, 4, "wheelchair_manual", "strict", datetime(2026, 10, 24, 12))
    naive, samaan = res["routes"]["naive_accessible"], res["routes"]["samaan"]
    assert naive["verified_pct"] == 0.0 and naive["unknown_pct"] == 100.0 and naive["n_unknown_stretches"] == 1
    assert naive["unknown_stretches"][0]["length_m"] == 200.0 and naive["unknown_stretches"][0]["edge_ids"] == [10, 11]
    assert samaan["verified_pct"] == 100.0 and samaan["length_m"] == pytest.approx(430.3, abs=0.1)
    assert samaan["eta_s"] == round(430.28 / WC) and res["routes"]["shortest"]["eta_s"] == round(200 / WALK)


def test_edge_kind_rules_steps_and_crossings():
    edges = [(10, 1, 2, "steps", "clear"), (11, 2, 4, "sidewalk", "clear"),
             (20, 1, 5, "sidewalk", "clear"), (21, 5, 3, "crossing", "clear"), (22, 3, 4, "sidewalk", "clear")]
    ctx = ctx_from(NODES, edges)
    assert edge_cost(ctx, ctx.edges[10], "wheelchair_manual", "samaan", "balanced", 12) is None
    assert edge_cost(ctx, ctx.edges[10], "wheelchair_manual", "shortest", "balanced", 12) == pytest.approx(100 / WALK)
    assert find_path(ctx, 1, 4, "wheelchair_manual", "samaan", "balanced", 12) == [1, 5, 3, 4]
    x = ctx.edges[21]
    unsig = edge_cost(ctx, x, "wheelchair_manual", "samaan", "balanced", 12)
    x.signal = True
    sig = edge_cost(ctx, x, "wheelchair_manual", "samaan", "balanced", 12)
    assert sig > unsig > x.length_m / WC
    x.kerb_ramp_start = False
    assert edge_cost(ctx, x, "wheelchair_manual", "samaan", "balanced", 12) is None  # known missing ramp
    assert edge_cost(ctx, x, "pram", "samaan", "balanced", 12) is not None


def test_time_of_day_changes_the_route():
    busy_day = [0.1 if h < 8 or h > 21 else 0.9 for h in range(24)]
    ctx = ctx_from(NODES, EDGES, {10: [barrier(7, "parked_vehicle", 4, False, busy_day)]})
    assert find_path(ctx, 1, 4, "wheelchair_manual", "samaan", "balanced", 14) == [1, 5, 3, 4]  # blocked at 14:00
    assert find_path(ctx, 1, 4, "wheelchair_manual", "samaan", "balanced", 3) == [1, 2, 4]      # scaled penalty at 03:00
    res = route_all_modes(ctx, 1, 4, "wheelchair_manual", "balanced", datetime(2026, 10, 24, 3))
    b = res["routes"]["samaan"]["barriers"][0]
    assert b["p_present"] == 0.1 and b["impassable_for_profile"] is True and b["class"] == "parked_vehicle"


def test_unreachable_returns_none():
    ctx = ctx_from(NODES, EDGES, {10: [barrier(1, "steps_or_high_kerb", 5)], 21: [barrier(2, "open_drain", 5)]})
    assert find_path(ctx, 1, 4, "wheelchair_manual", "samaan", "balanced", 12) is None
    res = route_all_modes(ctx, 1, 4, "wheelchair_manual", "balanced", None)
    assert res["routes"]["samaan"] is None and res["routes"]["shortest"] is not None


def test_heuristic_is_admissible_for_slow_profiles():
    # a grid where A* with a bad heuristic could pick a suboptimal path; compare with Dijkstra
    nodes = {i * 4 + j: (i * 50.0, j * 50.0) for i in range(4) for j in range(4)}
    edges = []
    eid = 1
    for i in range(4):
        for j in range(4):
            if i + 1 < 4:
                edges.append((eid, i * 4 + j, (i + 1) * 4 + j, "sidewalk", "clear" if (i + j) % 3 else "unknown")); eid += 1
            if j + 1 < 4:
                edges.append((eid, i * 4 + j, i * 4 + j + 1, "sidewalk", "clear" if (i * j) % 2 else "unknown")); eid += 1
    ctx = ctx_from(nodes, edges)
    path = find_path(ctx, 0, 15, "wheelchair_manual", "samaan", "strict", 12)
    ref = nx.dijkstra_path(ctx.graph, 0, 15, weight=lambda u, v, d: edge_cost(ctx, ctx.edges[d["id"]], "wheelchair_manual", "samaan", "strict", 12))
    cost = lambda p: sum(edge_cost(ctx, ctx.edges[ctx.graph[a][b]["id"]], "wheelchair_manual", "samaan", "strict", 12) for a, b in itertools.pairwise(p))
    assert cost(path) == pytest.approx(cost(ref))
