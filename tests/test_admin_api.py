"""Authority dashboard API on a private copy of the toy DB: token guard, summary counts, workers,
work-order lifecycle (assign -> in progress -> done marks the barrier fixed and drops it from
routing), invalid transitions, one open order per barrier, authority verify / reject of reports."""
from __future__ import annotations

import base64
import os
import shutil

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from api.db import get_engine
from api.models import Barrier
from common import config

TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/"
    "yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="
)


@pytest.fixture(scope="module")
def api_db(toy_db, tmp_path_factory):
    path = tmp_path_factory.mktemp("admindb") / "admin.sqlite"
    shutil.copy(toy_db, path)
    previous = os.environ.get("SAMAAN_DB")
    os.environ["SAMAAN_DB"] = str(path)
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


def test_token_guard(client, monkeypatch):
    monkeypatch.setenv("SAMAAN_ADMIN_TOKEN", "s3cret")
    assert client.get("/admin/summary").status_code == 401
    assert client.get("/admin/summary", headers={"X-Admin-Token": "wrong"}).status_code == 401
    r = client.get("/admin/summary", headers={"X-Admin-Token": "s3cret"})
    assert r.status_code == 200 and r.json()["auth"] == "token"
    monkeypatch.delenv("SAMAAN_ADMIN_TOKEN")
    assert client.get("/admin/summary").json()["auth"] == "open"


def test_summary_shape(client):
    s = client.get("/admin/summary").json()
    for k in ("reports", "barriers", "work_orders", "workers", "fixed_last_7_days", "median_hours_to_close"):
        assert k in s
    assert s["barriers"]["active"] >= 1
    assert s["median_hours_to_close"] is None  # no closed work order yet: no invented number


def test_work_order_lifecycle_fixes_barrier_and_routing(client):
    w = client.post("/admin/workers", json={"name": "Ramesh", "phone": "98xxxxxx01", "department": "Civil works", "area": "Block A"})
    assert w.status_code == 201
    wid = w.json()["id"]
    barriers = client.get("/admin/barriers").json()["results"]
    assert barriers and all(b["status"] == "active" for b in barriers)
    b = barriers[0]
    assert b["work_order"] is None

    o = client.post("/admin/workorders", json={"barrier_id": b["id"], "worker_id": wid, "priority": "high", "due_date": "2099-01-01", "note": "bring ramp kit"})
    assert o.status_code == 201, o.text
    oid = o.json()["id"]
    assert o.json()["status"] == "assigned" and o.json()["worker_name"] == "Ramesh"
    # one open order per barrier
    assert client.post("/admin/workorders", json={"barrier_id": b["id"]}).status_code == 409
    assert client.get("/admin/workers").json()["results"][0]["open_jobs"] == 1
    # invalid jump back to open from in_progress is allowed only via assigned; done -> anything is not
    assert client.patch(f"/admin/workorders/{oid}", json={"status": "in_progress", "by": "Ramesh"}).json()["status"] == "in_progress"

    before = client.get("/health").json()["barriers"]
    r = client.patch(f"/admin/workorders/{oid}", json={"status": "done", "resolution_note": "ramp built", "by": "JE civil"})
    assert r.status_code == 200 and r.json()["status"] == "done" and r.json()["completed_at"]
    assert [h["status"] for h in r.json()["history"]] == ["assigned", "in_progress", "done"]
    assert client.patch(f"/admin/workorders/{oid}", json={"status": "assigned"}).status_code == 400

    with Session(get_engine()) as s:
        fixed = s.get(Barrier, b["id"])
        assert fixed.status == "fixed" and fixed.fixed_at is not None and f"workorder:{oid}" in fixed.sources
    assert client.get("/admin/barriers?status=fixed").json()["count"] >= 1
    assert all(x["id"] != b["id"] for x in client.get("/admin/barriers").json()["results"])
    # the routing context no longer carries the barrier
    ctx = client.app.state.routing
    assert all(bi.id != b["id"] for lst in ctx.barriers_by_edge.values() for bi in lst)
    s2 = client.get("/admin/summary").json()
    assert s2["fixed_last_7_days"] == 1 and s2["median_hours_to_close"] is not None
    assert before >= 1


def test_open_order_needs_worker_before_progress(client):
    b = client.get("/admin/barriers").json()["results"][0]
    o = client.post("/admin/workorders", json={"barrier_id": b["id"]}).json()
    assert o["status"] == "open"
    assert client.patch(f"/admin/workorders/{o['id']}", json={"status": "in_progress"}).status_code == 400
    wid = client.get("/admin/workers").json()["results"][0]["id"]
    r = client.patch(f"/admin/workorders/{o['id']}", json={"worker_id": wid})
    assert r.json()["status"] == "assigned"
    assert client.patch(f"/admin/workorders/{o['id']}", json={"status": "cancelled"}).json()["status"] == "cancelled"
    assert client.get("/admin/workorders").json()["count"] == 0  # no open orders left


def test_authority_verify_and_reject_reports(client):
    z = config.zone()["center"]
    u = client.post("/users", json={"display_name": "asha", "profile": "wheelchair_manual", "language": "en"}).json()

    def report():
        r = client.post("/reports", data={"user_id": u["id"], "class_id": "parked_vehicle", "severity": "4", "lat": str(z["lat"]), "lon": str(z["lon"]),
                                          "device_lat": str(z["lat"]), "device_lon": str(z["lon"]), "kind": "barrier"},
                        files={"photo": ("r.jpg", TINY_JPEG, "image/jpeg")})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    a, b = report(), report()
    pending = client.get("/admin/reports").json()["results"]
    assert {a, b} <= {p["id"] for p in pending} and pending[0]["reporter"]["name"] == "asha"
    v = client.post(f"/admin/reports/{a}/decision", json={"decision": "verify", "note": "seen on site"})
    assert v.status_code == 200 and v.json()["status"] == "verified" and v.json()["barrier_id"]
    rj = client.post(f"/admin/reports/{b}/decision", json={"decision": "reject"})
    assert rj.json()["status"] == "rejected"
    assert client.post(f"/admin/reports/{b}/decision", json={"decision": "verify"}).status_code == 400
    assert any(x["id"] == v.json()["barrier_id"] for x in client.get("/admin/barriers").json()["results"])
