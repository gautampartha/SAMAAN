"""Demo mode on a private copy of the seeded toy DB: honest status counters, reset after a
report + vote + ride, the on-demand-zone guard, idempotence."""
from __future__ import annotations

import base64
import json
import os
import shutil

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import api.services.reports as reports_mod
from api.db import get_engine
from api.models import Barrier, Coverage, FootpathEdge, Image, Report, User, Vote
from common import config

TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/"
    "yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="
)
INT_KEYS = {
    "images": ("total", "real", "synthetic", "mapillary", "own_photo"),
    "barriers": ("total", "real", "synthetic", "active"),
    "coverage": ("edges_total", "edges_known_real", "edges_known_any"),
    "reports": ("pending", "verified", "rejected", "fixed"),
}


@pytest.fixture(scope="module")
def api_db(toy_db, tmp_path_factory):
    path = tmp_path_factory.mktemp("demodb") / "demo.sqlite"
    shutil.copy(toy_db, path)
    previous = os.environ.get("SAMAAN_DB")
    os.environ["SAMAAN_DB"] = str(path)
    # never read a developer's data/processed/active_zone.json: the guard is tested explicitly
    prev_zone = os.environ.get(config.ACTIVE_ZONE_FILE_ENV)
    os.environ[config.ACTIVE_ZONE_FILE_ENV] = str(tmp_path_factory.mktemp("zone") / "active_zone.json")
    config.clear_cache()
    yield path
    os.environ["SAMAAN_DB"] = previous or ""
    if prev_zone is None:
        os.environ.pop(config.ACTIVE_ZONE_FILE_ENV, None)
    else:
        os.environ[config.ACTIVE_ZONE_FILE_ENV] = prev_zone
    config.clear_cache()


@pytest.fixture(scope="module")
def client(api_db):
    from api.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def users(client):
    ids = {}
    for name in ("riya", "amit", "neha"):
        r = client.post("/users", json={"display_name": name, "profile": "wheelchair_manual", "language": "hi"})
        assert r.status_code == 201
        ids[name] = r.json()["id"]
    return ids


def _mapillary_image(session: Session) -> Image:
    z = config.zone()["center"]
    img = Image(source="mapillary", source_id="m1", lat=z["lat"], lon=z["lon"], heading_deg=90.0, hfov_deg=65.0,
                attribution="CC BY-SA 4.0 (test)", synthetic=False)
    session.add(img)
    session.commit()
    session.refresh(img)
    return img


def test_status_shape_and_honest_counts(client, api_db):
    with Session(get_engine(api_db)) as s:
        _mapillary_image(s)
        n_edges = len(s.exec(select(FootpathEdge)).all())
        synthetic_barriers = len(s.exec(select(Barrier).where(Barrier.synthetic == True)).all())
    st = client.get("/demo/status").json()
    for block, keys in INT_KEYS.items():
        for k in keys:
            assert isinstance(st[block][k], int) and st[block][k] >= 0, (block, k)
    for k in ("votes", "users", "rides", "missions"):
        assert isinstance(st[k], int) and st[k] >= 0
    assert set(st["zone"]) >= {"name", "display_name"} and st["zone"]["name"] == config.zone()["name"]
    assert st["synthetic_present"] is True  # the toy DB is seeded
    assert st["barriers"]["synthetic"] == synthetic_barriers and st["barriers"]["real"] == 0
    assert st["images"] == {"total": 1, "real": 1, "synthetic": 0, "mapillary": 1, "own_photo": 0, "report_photo": 0}
    cov = st["coverage"]
    assert cov["edges_total"] == n_edges and 0 < cov["edges_known_any"] <= n_edges
    assert cov["edges_known_real"] == 0  # every known state came from the seed, nothing real yet
    assert cov["pct_real"] == 0.0 and 0 < cov["pct_any"] <= 100.0
    assert cov["pct_any"] == pytest.approx(100.0 * cov["edges_known_any"] / n_edges, abs=0.06)
    assert sum(cov["states"].values()) == n_edges
    assert st["reports"] == {"total": 0, "pending": 0, "verified": 0, "rejected": 0, "fixed": 0} and st["votes"] == 0


def test_reset_removes_demo_activity_and_keeps_seed(client, users, api_db):
    z = client.get("/zone").json()["center"]
    r = client.post("/reports", files={"photo": ("p.jpg", TINY_JPEG, "image/jpeg")},
                    data={"user_id": users["riya"], "class_id": "steps_or_high_kerb", "severity": 5, "lat": z["lat"], "lon": z["lon"],
                          "width": 1, "height": 1})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    photo_path = reports_mod.REPORT_DIR / f"{r.json()['photo_url'].split('/')[2]}.jpg"
    assert photo_path.exists()
    for u in ("amit", "neha"):
        v = client.post(f"/reports/{rid}/votes", json={"user_id": users[u], "value": "agree"}).json()
    assert v["resolved"] and v["barrier_id"]
    # a verified "fixed" report closes a seed barrier
    with Session(get_engine(api_db)) as s:
        seed_b = s.exec(select(Barrier).where(Barrier.synthetic == True, Barrier.status == "active")).first()
    f = client.post("/reports", data={"user_id": users["amit"], "class_id": seed_b.class_id, "severity": 1, "lat": seed_b.lat,
                                      "lon": seed_b.lon, "kind": "fixed", "target_barrier_id": seed_b.id}).json()
    for u in ("riya", "neha"):
        client.post(f"/reports/{f['id']}/votes", json={"user_id": users[u], "value": "agree"})
    # and a synthetic ride replay adds wheel coverage / ride rows
    assert client.post("/rides/replay-demo", json={"user_id": users["riya"]}).status_code in (200, 201)

    before = client.get("/demo/status").json()
    assert before["reports"]["verified"] >= 2 and before["votes"] >= 4 and before["barriers"]["real"] >= 1
    assert before["rides"] == 1 and before["images"]["report_photo"] == 1 and before["coverage"]["edges_known_real"] > 0
    with Session(get_engine(api_db)) as s:
        assert s.get(Barrier, seed_b.id).status == "fixed"
        assert s.get(User, users["riya"]).trust_score > 0.3

    res = client.post("/demo/reset")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "reset"
    d = body["deleted"]
    assert d["reports"] == before["reports"]["total"] and d["votes"] == before["votes"] and d["rides"] == 1
    assert d["images_own_or_report"] == 1 and d["photo_files"] == 1 and d["barriers"] >= 1
    assert d["barriers_restored"] >= 1 and d["coverage_wheel"] >= 1
    assert "coverage" in body["recompute"] and "states" in body["recompute"]
    assert not photo_path.exists()

    st = client.get("/demo/status").json()
    assert {k: st[k] for k in ("images", "barriers", "coverage", "reports", "votes", "rides", "missions", "zone", "synthetic_present")} == \
           {k: body[k] for k in ("images", "barriers", "coverage", "reports", "votes", "rides", "missions", "zone", "synthetic_present")}
    assert st["reports"] == {"total": 0, "pending": 0, "verified": 0, "rejected": 0, "fixed": 0}
    assert st["votes"] == 0 and st["rides"] == 0
    assert st["images"]["mapillary"] == 1 and st["images"]["report_photo"] == 0 and st["images"]["own_photo"] == 0
    assert st["barriers"]["real"] == 0 and st["barriers"]["synthetic"] == before["barriers"]["synthetic"]
    assert st["synthetic_present"] is True
    assert st["coverage"]["edges_known_real"] == 0 and st["coverage"]["pct_real"] == 0.0
    assert st["users"] == 3  # users survive, trust is back to the configured start
    with Session(get_engine(api_db)) as s:
        assert s.exec(select(Report)).all() == [] and s.exec(select(Vote)).all() == []
        assert s.exec(select(Coverage).where(Coverage.source == "wheel")).all() == []
        b = s.get(Barrier, seed_b.id)
        assert b.status == "active" and b.fixed_at is None and all(x.startswith("seed:") for x in b.sources)
        assert s.exec(select(Image).where(Image.source == "mapillary")).first() is not None
        assert all(u.trust_score == pytest.approx(0.3) for u in s.exec(select(User)).all())
        assert not any(e.state != "unknown" and not e.state_synthetic for e in s.exec(select(FootpathEdge)).all())
    # the routing context saw the restored state: the route no longer carries a real (report) barrier
    route = client.get("/route", params={"demo": "riya"}).json()
    assert route["routes"]["samaan"] is not None and client.get("/health").json()["status"] == "ok"

    # idempotent: a second reset deletes nothing and leaves the same status
    again = client.post("/demo/reset").json()
    assert all(v == 0 for v in again["deleted"].values()), {k: v for k, v in again["deleted"].items() if v}
    assert again["barriers"] == st["barriers"] and again["coverage"] == st["coverage"] and again["images"] == st["images"]


def test_reset_refuses_on_demand_zone(client):
    f = config.active_zone_file()
    f.write_text(json.dumps({"name": "elsewhere", "display_name": {"en": "Elsewhere", "hi": "कहीं और"},
                             "bbox": {"south": 1, "west": 2, "north": 3, "east": 4}, "center": {"lat": 2, "lon": 3},
                             "anchors": [], "raw_cache": "data/raw/zone_elsewhere.osm"}))
    config.clear_cache()
    try:
        assert client.get("/demo/status").json()["zone"]["on_demand"] is True
        r = client.post("/demo/reset")
        assert r.status_code == 409 and "on demand" in r.json()["detail"]
    finally:
        f.unlink()
        config.clear_cache()
    assert client.get("/demo/status").json()["zone"]["on_demand"] is False
