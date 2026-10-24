"""Footpath synthesis on toy road layouts (plan 6.1, rule 11.5: geometry tests)."""
from __future__ import annotations

import networkx as nx
import pytest
from shapely.geometry import LineString, Point

from common import config
from common.crs import METRIC
from common.geo import side_of_line
from pipeline.graph.synthesize import classify, road_half_width, synthesize

CFG = config.pipeline()["footpath_synthesis"]
OFF_RES = CFG["default_half_width_m_by_highway"]["residential"] + CFG["sidewalk_offset_extra_m"]  # 4.5


def roads(nodes: dict[int, tuple[float, float]], edges: list[tuple[int, int, dict]]) -> nx.MultiGraph:
    G = nx.MultiGraph(crs=METRIC)
    for n, (x, y) in nodes.items():
        G.add_node(n, x=x, y=y)
    for u, v, d in edges:
        d = {"highway": "residential", "osmid": 100 + u, **d}
        d["length"] = Point(nodes[u]).distance(Point(nodes[v]))
        G.add_edge(u, v, **d)
    return G


def edges_of_kind(F: nx.MultiGraph, kind: str) -> list[dict]:
    return [d for _, _, d in F.edges(data=True) if d["kind"] == kind]


def test_half_width_sources():
    assert road_half_width({"highway": "residential"}, CFG) == 3.5
    assert road_half_width({"highway": "primary"}, CFG) == 7.0
    assert road_half_width({"highway": "residential", "width": "10"}, CFG) == 5.0
    assert road_half_width({"highway": "residential", "width": "10.5 m"}, CFG) == 5.25
    assert road_half_width({"highway": "residential", "lanes": "4"}, CFG) == 7.0
    assert road_half_width({"highway": "unknown_class"}, CFG) == CFG["default_half_width_m_by_highway"]["default"]


def test_classify():
    assert classify({"highway": "residential"}, CFG) == "sidewalk"
    assert classify({"highway": "residential", "sidewalk": "no"}, CFG) == "shared"
    assert classify({"highway": "service", "service": "driveway"}, CFG) == "shared"
    assert classify({"highway": "footway"}, CFG) == "footway"
    assert classify({"highway": "steps"}, CFG) == "steps"
    assert classify({"highway": "motorway"}, CFG) == "shared"  # never synthesised; kept only if walkable upstream


def test_single_road_two_sidewalks_on_correct_sides():
    G = roads({1: (0, 0), 2: (100, 0)}, [(1, 2, {})])
    F, stats = synthesize(G, [], CFG)
    sw = edges_of_kind(F, "sidewalk")
    assert len(sw) == 2 and stats["sidewalk"] == 2
    road = LineString([(0, 0), (100, 0)])
    for d in sw:
        mid = d["geometry"].interpolate(0.5, normalized=True)
        assert abs(abs(mid.y) - OFF_RES) < 1e-6
        assert side_of_line(road, mid) == d["side"]
        assert abs(d["length"] - 100.0) < 1e-6  # dead ends: no trimming
        assert d["synthesized"] is True and d["parent_road_osm_id"] == 101
    # a crossing loops around each dead end
    xs = edges_of_kind(F, "crossing")
    assert len(xs) == 2 and all(abs(d["length"] - 2 * OFF_RES) < 1e-6 for d in xs)
    assert all(d["signal"] is None and d["kerb_ramp_start"] is None for d in xs)
    assert nx.number_connected_components(F) == 1
    assert F.number_of_nodes() == 4 and F.number_of_edges() == 4


def test_four_way_junction_ring():
    G = roads({0: (0, 0), 1: (100, 0), 2: (0, 100), 3: (-100, 0), 4: (0, -100)},
              [(0, 1, {}), (0, 2, {}), (0, 3, {}), (0, 4, {})])
    F, stats = synthesize(G, [], CFG)
    assert stats["sidewalk"] == 8
    assert stats["crossing_junction"] == 4 + 4  # 4 at the centre, 4 around the dead ends
    assert stats["corner"] == 4
    assert nx.number_connected_components(F) == 1
    # sidewalks are trimmed back by the crossing road's offset at the junction
    for d in edges_of_kind(F, "sidewalk"):
        if d.get("osm_tags", {}).get("corner"):
            continue
        assert abs(d["length"] - (100 - OFF_RES)) < 1e-6
    centre_x = [d for d in edges_of_kind(F, "crossing") if d["osm_tags"].get("at_junction")
                and Point(d["geometry"].coords[0]).distance(Point(0, 0)) < 10]
    assert len(centre_x) == 4 and all(abs(d["length"] - 2 * OFF_RES) < 1e-6 for d in centre_x)


def test_t_junction_signal_and_kerb_from_node_tags():
    G = roads({0: (0, 0), 1: (100, 0), 2: (-100, 0), 3: (0, 100)}, [(0, 1, {}), (0, 2, {}), (0, 3, {})])
    G.nodes[0]["highway"] = "traffic_signals"
    G.nodes[0]["kerb"] = "lowered"
    F, _ = synthesize(G, [], CFG)
    centre = [d for d in edges_of_kind(F, "crossing") if d["osm_tags"].get("at_junction")
              and Point(d["geometry"].coords[0]).distance(Point(0, 0)) < 10]
    assert len(centre) == 3
    assert all(d["signal"] is True and d["kerb_ramp_start"] is True and d["kerb_ramp_end"] is True for d in centre)
    assert nx.number_connected_components(F) == 1


def test_sidewalk_no_becomes_shared_road():
    G = roads({1: (0, 0), 2: (100, 0)}, [(1, 2, {"sidewalk": "no"})])
    F, stats = synthesize(G, [], CFG)
    assert stats["shared"] == 1 and stats["sidewalk"] == 0
    rs = edges_of_kind(F, "road_shared")
    assert len(rs) == 1 and rs[0]["synthesized"] is False and rs[0]["osm_tags"]["sidewalk"] == "no"


def test_sidewalk_left_only():
    G = roads({1: (0, 0), 2: (100, 0)}, [(1, 2, {"sidewalk": "left"})])
    F, _ = synthesize(G, [], CFG)
    sw = edges_of_kind(F, "sidewalk")
    assert len(sw) == 1 and sw[0]["side"] == "L" and sw[0]["geometry"].interpolate(50).y > 0
    assert edges_of_kind(F, "crossing") == []  # nothing to cross to


def test_midblock_crossing_node_splits_sidewalks():
    G = roads({1: (0, 0), 2: (200, 0)}, [(1, 2, {})])
    cn = [{"id": 999, "x": 100.0, "y": 0.0, "tags": {"highway": "crossing", "crossing": "traffic_signals", "kerb": "lowered"}}]
    F, stats = synthesize(G, cn, CFG)
    assert stats["crossing_midblock"] == 1
    sw = edges_of_kind(F, "sidewalk")
    assert len(sw) == 4 and all(abs(d["length"] - 100.0) < 1e-6 for d in sw)
    mid = [d for d in edges_of_kind(F, "crossing") if d["osm_tags"].get("osm_crossing_node") == 999]
    assert len(mid) == 1
    assert mid[0]["signal"] is True and mid[0]["kerb_ramp_start"] is True
    assert abs(mid[0]["length"] - 2 * OFF_RES) < 1e-6
    assert abs(mid[0]["geometry"].interpolate(0.5, normalized=True).x - 100.0) < 1e-6
    assert nx.number_connected_components(F) == 1


def test_midblock_crossing_far_from_any_road_is_ignored():
    G = roads({1: (0, 0), 2: (200, 0)}, [(1, 2, {})])
    F, stats = synthesize(G, [{"id": 5, "x": 100.0, "y": 30.0, "tags": {"highway": "crossing"}}], CFG)
    assert stats["crossing_midblock"] == 0 and len(edges_of_kind(F, "sidewalk")) == 2


def test_footway_connects_to_nearest_sidewalk_within_5m():
    G = roads({1: (0, 0), 2: (100, 0), 10: (50, 7), 11: (50, 50)},
              [(1, 2, {}), (10, 11, {"highway": "footway", "osmid": 777})])
    F, stats = synthesize(G, [], CFG)
    assert stats["footway"] == 1 and stats["connector"] == 1 and stats["footway_dangling"] == 1  # node 11 is far
    con = edges_of_kind(F, "connector")
    assert len(con) == 1 and abs(con[0]["length"] - (7 - OFF_RES)) < 1e-6
    assert len(edges_of_kind(F, "sidewalk")) == 3  # the left sidewalk was split at x=50
    assert nx.number_connected_components(F) == 1


def test_footway_meeting_a_road_node_joins_via_hub():
    G = roads({1: (0, 0), 2: (100, 0), 3: (100, 60)}, [(1, 2, {}), (2, 3, {"highway": "footway"})])
    F, stats = synthesize(G, [], CFG)
    assert stats["footway"] == 1
    hub = [d for d in edges_of_kind(F, "connector") if d["osm_tags"].get("via_junction")]
    assert len(hub) == 2 and all(abs(d["length"] - OFF_RES) < 1e-6 for d in hub)
    assert nx.number_connected_components(F) == 1


def test_steps_kept_with_tags():
    G = roads({1: (0, 0), 2: (100, 0), 2.5: (100, 10), 4: (100, 20)},
              [(1, 2, {}), (2, 2.5, {"highway": "steps", "step_count": "6", "handrail": "yes"}),
               (2.5, 4, {"highway": "footway"})])
    F, _ = synthesize(G, [], CFG)
    st = edges_of_kind(F, "steps")
    assert len(st) == 1 and st[0]["osm_tags"]["step_count"] == "6" and st[0]["synthesized"] is False


def test_too_short_road_falls_back_to_shared():
    # 6 m stub between two 4-way junctions: trimmed sidewalk would be < 2 m
    G = roads({0: (0, 0), 1: (6, 0), 2: (0, 100), 3: (0, -100), 4: (6, 100), 5: (6, -100), 6: (-100, 0), 7: (106, 0)},
              [(0, 1, {}), (0, 2, {}), (0, 3, {}), (1, 4, {}), (1, 5, {}), (6, 0, {}), (1, 7, {})])
    F, stats = synthesize(G, [], CFG)
    assert stats["short_fallback"] == 1 and stats["shared"] == 1
    assert nx.number_connected_components(F) == 1


@pytest.mark.parametrize("n", [3, 5])
def test_grid_is_one_component_without_dangling_ends(n):
    nodes = {i * n + j: (i * 100.0, j * 100.0) for i in range(n) for j in range(n)}
    edges = []
    for i in range(n):
        for j in range(n):
            if i + 1 < n:
                edges.append((i * n + j, (i + 1) * n + j, {}))
            if j + 1 < n:
                edges.append((i * n + j, i * n + j + 1, {}))
    F, _ = synthesize(roads(nodes, edges), [], CFG)
    assert nx.number_connected_components(F) == 1
    assert all(deg >= 2 for _, deg in F.degree())
    assert len(edges_of_kind(F, "sidewalk")) >= 2 * len(edges)
