"""Reach Gap on toy graphs (plan 6.7, known answers) and the /reach API on the toy fixture."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api.services.reach import fix_candidates, rank_fixes, reach, reach_gap
from common import config
from tests.test_routing import NODES, barrier, ctx_from

P = config.profiles()
WALK = float(P["profiles"]["walker"]["speed_m_s"]["value"])
WC = float(P["profiles"]["wheelchair_manual"]["speed_m_s"]["value"])

# A chain 1-2-4 (100 m + 100 m) and a detour 1-5-3-4 (150 + 100 + 180.3)
EDGES = [(10, 1, 2, "sidewalk", "clear"), (11, 2, 4, "sidewalk", "clear"),
         (20, 1, 5, "sidewalk", "clear"), (21, 5, 3, "sidewalk", "clear"), (22, 3, 4, "sidewalk", "clear")]
TOTAL = 100 + 100 + 150 + 100 + 180.278


def test_reach_counts_partial_edges():
    ctx = ctx_from(NODES, EDGES)
    # walker at 1.3 m/s for 100 s reaches 130 m of network from node 1: 100 m to node 2 + 30 m
    # beyond, and 130 m along edge 20 (150 m long) -> 260 m
    r = reach(ctx, 1, "walker", 100.0, "naive_accessible", "balanced", 12, with_hull=False)
    assert r.reach_m == pytest.approx(130 + 130, abs=0.5)
    assert set(r.edge_ids) == {10, 11, 20} and r.edge_fraction[11] == pytest.approx(0.3, abs=0.01)
    # unlimited time reaches everything exactly once
    r_all = reach(ctx, 1, "walker", 10_000.0, "naive_accessible", "balanced", 12, with_hull=False)
    assert r_all.reach_m == pytest.approx(TOTAL, abs=0.5) and len(r_all.edge_ids) == 5


def test_gap_and_greedy_fix_ranking():
    # steps block the short way (sev 5), a sev-4 open drain blocks the detour: a wheelchair reaches nothing
    ctx = ctx_from(NODES, EDGES, {10: [barrier(1, "steps_or_high_kerb", 5)], 20: [barrier(2, "open_drain", 4)]})
    res = reach_gap(ctx, 1, "wheelchair_manual", 1000 / 60, "balanced", 12)
    assert res["walker"]["reach_km"] == pytest.approx(TOTAL / 1000, abs=0.001)
    assert res["target"]["reach_km"] == 0.0 and res["ratio"] == 0.0
    assert res["gap_km"] == pytest.approx(TOTAL / 1000, abs=0.001)
    fixes = res["fixes"]
    assert [f["barrier"]["id"] for f in fixes] == [1, 2] or [f["barrier"]["id"] for f in fixes] == [2, 1]
    # fixing the steps alone opens the chain (200 m) and, via node 4, edges 22 and 21 and 20 from the other
    # side ... but edge 20 itself stays blocked; the greedy second fix adds what is left
    first = fixes[0]
    assert first["rank"] == 1 and first["gain_km"] > 0 and first["cumulative_reach_km"] == pytest.approx(first["gain_km"])
    assert fixes[1]["cumulative_reach_km"] == pytest.approx(TOTAL / 1000, abs=0.001)
    assert first["cost_is_estimate"] is True and first["cost_lakh_min"] is None and first["gain_km_per_lakh"] is None
    # simulate: fixing both restores the walker's reach
    sim = reach_gap(ctx, 1, "wheelchair_manual", 1000 / 60, "balanced", 12, fixed={1, 2})
    assert sim["simulated"]["reach_km"] == pytest.approx(TOTAL / 1000, abs=0.001) and sim["simulated_gap_km"] == pytest.approx(0.0, abs=0.001)
    assert sim["simulated_fixed_ids"] == [1, 2]


def test_fix_candidates_only_inside_walker_reach_and_costly_for_profile():
    ctx = ctx_from(NODES, EDGES, {10: [barrier(1, "curb_ramp", 1)], 22: [barrier(2, "steps_or_high_kerb", 5)]})
    walker = reach(ctx, 1, "walker", 100.0, "naive_accessible", "balanced", 12, with_hull=False)  # reaches 10, 11, 20 only
    cands = fix_candidates(ctx, walker, "wheelchair_manual", 60)
    assert cands == []  # curb_ramp costs nothing; the steps are outside the walker's reach
    walker_all = reach(ctx, 1, "walker", 10_000.0, "naive_accessible", "balanced", 12, with_hull=False)
    assert [b.id for b in fix_candidates(ctx, walker_all, "wheelchair_manual", 60)] == [2]
    ranked = rank_fixes(ctx, 1, "wheelchair_manual", 10_000.0, "balanced", 12, walker_all,
                        reach(ctx, 1, "wheelchair_manual", 10_000.0, "samaan", "balanced", 12, with_hull=False), 5, 60)
    assert len(ranked) == 1 and ranked[0]["barrier"]["id"] == 2 and ranked[0]["gain_km"] == pytest.approx(0.180, abs=0.001)


def test_hull_is_a_polygon_in_wgs84():
    ctx = ctx_from(NODES, EDGES)
    r = reach(ctx, 1, "walker", 10_000.0, "naive_accessible", "balanced", 12)
    assert r.hull is not None and r.hull["type"] in ("Polygon", "MultiPolygon")
    lon, lat = (r.hull["coordinates"][0][0] if r.hull["type"] == "Polygon" else r.hull["coordinates"][0][0][0])
    assert -180 <= lon <= 180 and -90 <= lat <= 90


@pytest.fixture(scope="module")
def client(toy_db):
    from api.main import app

    with TestClient(app) as c:
        yield c


def test_reach_api(client):
    anchors = client.get("/reach/anchors").json()["anchors"]
    assert anchors and anchors[0]["id"] == "metro_karkarduma" and anchors[0]["name_hi"]
    r = client.get("/reach", params={"anchor": "metro_karkarduma", "profile": "wheelchair_manual", "cutoff_min": 5})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["walker"]["reach_km"] > 0 and body["walker"]["reach_km"] >= body["target"]["reach_km"]
    assert body["gap_km"] == pytest.approx(body["walker"]["reach_km"] - body["target"]["reach_km"], abs=0.002)
    assert body["walker"]["hull"]["type"] in ("Polygon", "MultiPolygon") and body["synthetic_overlay"] is True
    assert body["anchor"]["id"] == "metro_karkarduma" and body["simulated"] is None
    assert all(f["rank"] == i + 1 for i, f in enumerate(body["fixes"])) and len(body["fixes"]) <= 5
    if body["fixes"]:
        ids = ",".join(str(f["barrier"]["id"]) for f in body["fixes"])
        sim = client.get("/reach", params={"anchor": "metro_karkarduma", "cutoff_min": 5, "fixed": ids}).json()
        assert sim["simulated"]["reach_km"] >= body["target"]["reach_km"] and sim["simulated_gap_km"] <= body["gap_km"] + 1e-6
    assert client.get("/reach", params={"anchor": "nope"}).status_code == 404
    assert client.get("/reach", params={"anchor": "metro_karkarduma", "profile": "walker"}).status_code == 422
    assert client.get("/reach", params={"anchor": "metro_karkarduma", "cutoff_min": 0}).status_code == 422
    assert client.get("/reach", params={"anchor": "metro_karkarduma", "fixed": "a,b"}).status_code == 422
