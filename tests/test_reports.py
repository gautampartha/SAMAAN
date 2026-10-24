"""Plan 6.8/6.9 on a private copy of the seeded toy DB: report -> votes -> barrier -> route change,
trust, abuse checks, fixed flow, missions, active-learning export."""
from __future__ import annotations

import base64
import os
import shutil

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from api.db import get_engine
from api.models import Barrier, FootpathEdge, Mission, Report, User
from api.services.reports import REPORT_DIR
from ml.export_active_learning import export as export_active

TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/"
    "yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="
)


@pytest.fixture(scope="module")
def api_db(toy_db, tmp_path_factory):
    path = tmp_path_factory.mktemp("repdb") / "reports.sqlite"
    shutil.copy(toy_db, path)
    previous = os.environ.get("SAMAAN_DB")
    os.environ["SAMAAN_DB"] = str(path)
    yield path
    os.environ["SAMAAN_DB"] = previous or ""


@pytest.fixture(scope="module")
def client(api_db):
    from api.main import app

    with TestClient(app) as c:
        yield c
    for r in (REPORT_DIR).glob("*.jpg"):
        r.unlink(missing_ok=True)


@pytest.fixture(scope="module")
def users(client):
    ids = {}
    for name in ("riya", "amit", "neha", "sunil"):
        r = client.post("/users", json={"display_name": name, "profile": "wheelchair_manual", "language": "hi"})
        assert r.status_code == 201 and r.json()["trust_score"] == 0.3
        ids[name] = r.json()["id"]
    return ids


def _samaan_edges(client):
    body = client.get("/route", params={"demo": "riya", "profile": "wheelchair_manual", "risk": "balanced"}).json()
    return body["routes"]["samaan"]["edge_ids"], body


def test_report_pending_then_verified_changes_route(client, users, api_db):
    edge_ids, _before = _samaan_edges(client)
    # pick a clear sidewalk edge in the middle of the SAMAAN route and report steps (severity 5) there
    with Session(get_engine(api_db)) as s:
        edges = {e.id: e for e in s.exec(select(FootpathEdge)).all()}
        target = next(edges[i] for i in edge_ids[2:-2] if edges[i].kind == "sidewalk" and edges[i].state == "clear")
        from shapely import wkt

        from common.crs import to_wgs84
        pt = to_wgs84(wkt.loads(target.geom_m_wkt).interpolate(0.5, normalized=True))
    r = client.post("/reports", files={"photo": ("p.jpg", TINY_JPEG, "image/jpeg")},
                    data={"user_id": users["riya"], "class_id": "steps_or_high_kerb", "severity": 5, "lat": pt.y, "lon": pt.x,
                          "device_lat": pt.y, "device_lon": pt.x, "note": "two steps at the shop front", "width": 1, "height": 1})
    assert r.status_code == 201, r.text
    item = r.json()
    assert item["status"] == "pending" and item["kind"] == "barrier" and item["photo_url"]
    assert item["edge_id"] is not None and item["model_prescreen_score"] is None  # no weights in tests
    assert item["name_hi"] and item["votes"] == {"agree": 0, "disagree": 0, "unsure": 0}
    rid = item["id"]
    # not a barrier yet
    assert not any(b["properties"].get("sources") and f"report:{rid}" in b["properties"]["sources"] for b in client.get("/layers/barriers").json()["features"])
    # queue: visible to others near the spot, not to the reporter
    q = client.get("/reports", params={"status": "pending", "near_lat": pt.y, "near_lon": pt.x, "radius_m": 300, "user_id": users["amit"]}).json()
    assert q["count"] >= 1 and q["results"][0]["id"] == rid and q["results"][0]["distance_m"] < 1.0
    own = client.get("/reports", params={"status": "pending", "user_id": users["riya"]}).json()
    assert all(x["id"] != rid for x in own["results"])
    # votes: own vote rejected; one new user (0.3) is not enough, a second agreement reaches 0.6 -> verified
    assert client.post(f"/reports/{rid}/votes", json={"user_id": users["riya"], "value": "agree"}).status_code == 409
    v1 = client.post(f"/reports/{rid}/votes", json={"user_id": users["amit"], "value": "agree"}).json()
    assert v1["resolved"] is False and v1["score"] == pytest.approx(0.3) and v1["n_votes"] == 1
    v2 = client.post(f"/reports/{rid}/votes", json={"user_id": users["neha"], "value": "unsure"}).json()
    assert v2["resolved"] is False and v2["score"] == pytest.approx(0.3)
    v3 = client.post(f"/reports/{rid}/votes", json={"user_id": users["neha"], "value": "agree"}).json()  # changed mind
    assert v3["n_votes"] == 2 and v3["score"] == pytest.approx(0.6)
    assert v3["resolved"] is True and v3["status"] == "verified" and v3["barrier_id"]
    assert v3["voter_trust_score"] == pytest.approx(0.35)
    # barrier exists, edge blocked, route changed, reporter trust rose
    with Session(get_engine(api_db)) as s:
        b = s.get(Barrier, v3["barrier_id"])
        assert b.class_id == "steps_or_high_kerb" and b.severity == 5 and not b.synthetic and f"report:{rid}" in b.sources
        assert s.get(FootpathEdge, b.edge_id).state == "blocked" and s.get(FootpathEdge, b.edge_id).state_synthetic is False
        assert s.get(User, users["riya"]).trust_score == pytest.approx(0.4)
        assert s.get(Report, rid).status == "verified"
    after_edges, _after = _samaan_edges(client)
    assert b.edge_id in edge_ids and b.edge_id not in after_edges  # SAMAAN now avoids the reported steps
    assert client.post(f"/reports/{rid}/votes", json={"user_id": users["amit"], "value": "agree"}).status_code == 400
    assert client.get(f"/reports/{rid}", params={"user_id": users["amit"]}).json()["my_vote"] == "agree"


def test_duplicate_report_updates_existing_barrier(client, users, api_db):
    with Session(get_engine(api_db)) as s:
        b = s.exec(select(Barrier).where(Barrier.synthetic == False)).first()
    r = client.post("/reports", data={"user_id": users["amit"], "class_id": b.class_id, "severity": 3, "lat": b.lat, "lon": b.lon}).json()
    assert r["duplicate_of_barrier_id"] == b.id and r["photo_url"] is None
    for u in ("neha", "sunil"):
        res = client.post(f"/reports/{r['id']}/votes", json={"user_id": users[u], "value": "agree"}).json()
    assert res["resolved"] and res["barrier_id"] == b.id
    with Session(get_engine(api_db)) as s:
        b2 = s.get(Barrier, b.id)
        assert b2.severity == 4 and b2.confidence > b.confidence and f"report:{r['id']}" in b2.sources
        assert len(s.exec(select(Barrier).where(Barrier.synthetic == False)).all()) == 1


def test_rejection_lowers_reporter_trust(client, users, api_db):
    z = client.get("/zone").json()["center"]
    r = client.post("/reports", data={"user_id": users["sunil"], "class_id": "open_drain", "severity": 4, "lat": z["lat"], "lon": z["lon"]}).json()
    with Session(get_engine(api_db)) as s:
        before = s.get(User, users["sunil"]).trust_score
    for u in ("riya", "amit"):
        res = client.post(f"/reports/{r['id']}/votes", json={"user_id": users[u], "value": "disagree"}).json()
    assert res["resolved"] and res["status"] == "rejected" and res["barrier_id"] is None
    with Session(get_engine(api_db)) as s:
        assert s.get(User, users["sunil"]).trust_score < before


def test_abuse_checks(client, users):
    z = client.get("/zone").json()["center"]
    far = client.post("/reports", data={"user_id": users["amit"], "class_id": "open_drain", "severity": 3, "lat": z["lat"], "lon": z["lon"],
                                       "device_lat": z["lat"] + 0.01, "device_lon": z["lon"]})
    assert far.status_code == 422 and far.json()["detail"] == "gps_offset"
    assert client.post("/reports", data={"user_id": 9999, "class_id": "open_drain", "severity": 3, "lat": z["lat"], "lon": z["lon"]}).status_code == 404
    assert client.post("/reports", data={"user_id": users["amit"], "class_id": "spaceship", "severity": 3, "lat": z["lat"], "lon": z["lon"]}).status_code == 422
    assert client.post("/reports", data={"user_id": users["amit"], "class_id": "open_drain", "severity": 9, "lat": z["lat"], "lon": z["lon"]}).status_code == 422
    assert client.post("/reports", data={"user_id": users["amit"], "class_id": "open_drain", "severity": 3, "lat": z["lat"], "lon": z["lon"],
                                        "kind": "fixed"}).status_code == 404
    # rate limit: 30 per hour per user
    codes = [client.post("/reports", data={"user_id": users["neha"], "class_id": "waterlogging", "severity": 2, "lat": z["lat"], "lon": z["lon"]}).status_code
             for _ in range(31)]
    assert codes.count(201) == 30 and codes[-1] == 429


def test_fixed_flow_closes_barrier(client, users, api_db):
    with Session(get_engine(api_db)) as s:
        b = s.exec(select(Barrier).where(Barrier.synthetic == False, Barrier.status == "active")).first()
        edge_state_before = s.get(FootpathEdge, b.edge_id).state
    assert edge_state_before == "blocked"
    r = client.post("/reports", files={"photo": ("fixed.jpg", TINY_JPEG, "image/jpeg")},
                    data={"user_id": users["riya"], "class_id": b.class_id, "severity": b.severity, "lat": b.lat, "lon": b.lon,
                          "kind": "fixed", "target_barrier_id": b.id, "width": 1, "height": 1})
    assert r.status_code == 201 and r.json()["kind"] == "fixed" and r.json()["target_barrier"]["id"] == b.id
    # a single team member (trust 0.8) verifies alone: the demo flow with a teammate on a second phone
    team = client.post("/users", json={"display_name": "crew", "profile": "walker", "team": True}).json()
    assert team["trust_score"] == 0.8
    res = client.post(f"/reports/{r.json()['id']}/votes", json={"user_id": team["id"], "value": "agree"}).json()
    assert res["resolved"] and res["barrier_id"] == b.id
    with Session(get_engine(api_db)) as s:
        b2 = s.get(Barrier, b.id)
        assert b2.status == "fixed" and b2.fixed_at is not None
        assert s.get(FootpathEdge, b.edge_id).state == "clear"
    assert all(f["properties"]["status"] != "active" or f["properties"]["id"] != b.id for f in client.get("/layers/barriers").json()["features"])


def test_missions_rank_unknown_stretches(client, api_db):
    r = client.post("/missions/recompute", params={"n_pairs": 60})
    assert r.status_code == 200
    summary = r.json()
    assert summary["routes_computed"] > 0 and summary["missions"] >= 1
    fc = client.get("/missions").json()
    assert fc["type"] == "FeatureCollection" and 1 <= fc["count"] <= 10
    props = [f["properties"] for f in fc["features"]]
    assert [p["rank"] for p in props] == list(range(1, len(props) + 1))
    assert all(p["priority"] > 0 and p["length_m"] > 0 and p["n_routes"] >= 1 and p["status"] == "open" for p in props)
    assert props[0]["priority"] >= props[-1]["priority"] and fc["features"][0]["geometry"]["type"] == "LineString"
    with Session(get_engine(api_db)) as s:
        edges = {e.id: e for e in s.exec(select(FootpathEdge)).all()}
        assert all(edges[i].state == "unknown" for p in props for i in p["edge_ids"])
        # mark one mission's edges clear -> status flips to done on the next read
        m = s.exec(select(Mission).where(Mission.rank == 1)).one()
        for i in m.edge_ids:
            edges[i].state = "clear"
            s.add(edges[i])
        s.commit()
    assert next(f for f in client.get("/missions").json()["features"] if f["properties"]["rank"] == 1)["properties"]["status"] == "done"


def test_active_learning_export(client, api_db, tmp_path, monkeypatch):
    from ml import dataset as ds
    from ml import export_active_learning as eal

    monkeypatch.setattr(ds, "LABELS_ROOT", tmp_path / "labels")
    monkeypatch.setattr(eal, "LABELS_ROOT", tmp_path / "labels")
    with Session(get_engine(api_db)) as s:
        stats = export_active(s, "active_test")
        n_verified_with_photo = len([r for r in s.exec(select(Report).where(Report.status == "verified", Report.kind == "barrier")).all() if r.photo_image_id])
    assert stats["exported"] == n_verified_with_photo >= 1 and stats["weak_boxes"] == stats["exported"]
    out = tmp_path / "labels" / "active_test"
    labels = list((out / "labels").glob("*.txt"))
    assert labels and labels[0].read_text().startswith("1 0.5")  # steps_or_high_kerb index 1, centred weak box
    manifest = (out / "manifest.csv").read_text()
    assert "needs_box_review" in manifest and ",true" in manifest and "synthetic" in manifest


def test_trusted_reporter_with_photo_is_verified_immediately(client, api_db):
    crew = client.post("/users", json={"display_name": "crew2", "profile": "walker", "team": True}).json()
    z = client.get("/zone").json()["center"]
    # pick a clear sidewalk edge midpoint far from existing barriers
    with Session(get_engine(api_db)) as s:
        from shapely import wkt

        from common.crs import to_wgs84
        e = next(e for e in s.exec(select(FootpathEdge)).all() if e.kind == "sidewalk" and e.state == "clear" and e.length_m > 50)
        pt = to_wgs84(wkt.loads(e.geom_m_wkt).interpolate(0.3, normalized=True))
    r = client.post("/reports", files={"photo": ("p.jpg", TINY_JPEG, "image/jpeg")},
                    data={"user_id": crew["id"], "class_id": "open_drain", "severity": 5, "lat": pt.y, "lon": pt.x,
                          "device_lat": pt.y, "device_lon": pt.x, "width": 1, "height": 1})
    assert r.status_code == 201, r.text
    item = r.json()
    assert item["status"] == "verified" and item["auto_verified"] is True and item["barrier_id"]
    with Session(get_engine(api_db)) as s:
        b = s.get(Barrier, item["barrier_id"])
        assert b.status == "active" and b.class_id == "open_drain" and not b.synthetic
        assert s.get(FootpathEdge, b.edge_id).state == "blocked"
    # without a photo, even a trusted user stays pending (photo is the evidence)
    r2 = client.post("/reports", data={"user_id": crew["id"], "class_id": "open_drain", "severity": 5, "lat": z["lat"], "lon": z["lon"]}).json()
    assert r2["status"] == "pending" and r2["auto_verified"] is False
