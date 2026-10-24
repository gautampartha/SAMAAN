"""GET /route on the seeded toy fixture (Riya's demo trip)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client(toy_db):
    from api.main import app

    with TestClient(app) as c:
        yield c


def test_route_demo_two_routes_with_confidence_and_steps(client):
    r = client.get("/route", params={"demo": "riya", "profile": "wheelchair_manual", "risk": "strict"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["routes"]) == {"standard", "samaan"}
    assert body["synthetic_overlay"] is True and body["demo"] == "riya"
    shortest, samaan = body["routes"]["standard"], body["routes"]["samaan"]
    assert shortest is not None and samaan is not None
    for rt in (shortest, samaan):
        assert rt["geometry"]["type"] == "LineString" and len(rt["geometry"]["coordinates"]) >= 2
        assert rt["length_m"] > 0 and rt["eta_s"] > 0 and 0 <= rt["verified_pct"] <= 100
        assert "unknown_stretches" in rt and "barriers" in rt and rt["synthetic"] is True
        assert 0 <= rt["confidence"]["score"] <= 1 and rt["confidence"]["label"] in ("high", "medium", "low")
        assert rt["segments_total"] == len(rt["edge_ids"]) and 0 <= rt["segments_no_recent_imagery"] <= rt["segments_total"]
        assert rt["steps"][0]["type"] == "depart" and rt["steps"][-1]["type"] == "arrive"
        assert rt["steps"][-1]["cumulative_m"] == pytest.approx(rt["length_m"], abs=1.0)
        assert all(st["instruction_hi"] for st in rt["steps"])
    full = client.get("/route", params={"demo": "riya", "modes": "all"}).json()
    assert set(full["routes"]) == {"standard", "samaan", "naive_accessible"}
    profiles = client.get("/profiles").json()["profiles"]
    assert {p["id"] for p in profiles} >= {"wheelchair_manual", "cognitive", "blind_low_vision", "walker"}
    assert next(p for p in profiles if p["id"] == "blind_low_vision")["mode"] == "listen"
    assert client.get("/route", params={"demo": "riya", "profile": "blind_low_vision"}).status_code == 200
    # the seeded story puts steps on the shortest path; SAMAAN must not route a wheelchair over them
    assert any(b["class"] == "steps_or_high_kerb" for b in shortest["barriers"])
    assert not any(b["impassable_for_profile"] for b in samaan["barriers"])
    assert samaan["length_m"] >= shortest["length_m"]
    assert shortest["profile"] == "walker" and samaan["profile"] == "wheelchair_manual" and samaan["risk"] == "strict"


def test_route_by_coordinates_and_errors(client):
    demo = client.get("/layers/demo").json()
    o = next(f for f in demo["features"] if f["properties"]["role"] == "origin")["geometry"]["coordinates"]
    d = next(f for f in demo["features"] if f["properties"]["role"] == "destination")["geometry"]["coordinates"]
    r = client.get("/route", params={"from_lon": o[0], "from_lat": o[1], "to_lon": d[0], "to_lat": d[1], "profile": "pram"})
    assert r.status_code == 200
    assert r.json()["origin"]["snap_distance_m"] < 1.0
    assert client.get("/route", params={"demo": "nope"}).status_code == 404
    assert client.get("/route", params={"demo": "riya", "profile": "robot"}).status_code == 422
    assert client.get("/route", params={"demo": "riya", "risk": "yolo"}).status_code == 422
    far = client.get("/route", params={"from_lon": 77.0, "from_lat": 28.0, "to_lon": d[0], "to_lat": d[1]})
    assert far.status_code == 404
    assert client.get("/route").status_code == 422
    reload = client.post("/route/reload").json()
    assert reload["edges"] > 0 and reload["edges_with_barriers"] > 0
