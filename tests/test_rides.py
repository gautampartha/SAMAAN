"""Plan 6.10: high-pass, windows, map-matching, verified-by-wheels, jolts; rides API; calibration."""
from __future__ import annotations

import os
import random
import shutil

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import LineString
from sqlmodel import Session, select

from api.db import get_engine
from api.models import Barrier, Coverage, EdgeRideStat, FootpathEdge, Ride
from common import config
from common.crs import xy_to_lonlat
from eval.ride_calibration import pick_thresholds
from pipeline.geolocate.geolocate import EdgeIndex
from pipeline.ride.process import (
    Sample,
    gravity_axis,
    highpass,
    make_windows,
    match_windows,
    synthetic_ride_samples,
    traversals,
)

CFG = config.pipeline()["ride"]
X0, Y0 = 750_000.0, 3_170_000.0


def test_gravity_axis_and_highpass():
    s = [Sample(i / 50, 0.1, 0.2, 9.81) for i in range(100)]
    assert gravity_axis(s) == "az"
    t = [i / 50 for i in range(200)]
    vals = [9.81 + (2.0 if i == 100 else 0.0) for i in range(200)]
    hp = highpass(vals, t, 1.0)
    assert abs(hp[10]) < 0.1 and hp[100] > 1.5           # gravity removed, the spike kept


def _ride_along(line: LineString, speed=0.9, hz=50.0, rms=0.3, jolt_t=None, seed=1):
    rng = random.Random(seed)
    duration = line.length / speed
    out = []
    for i in range(int(duration * hz)):
        t = i / hz
        az = 9.81 + rng.gauss(0, rms) + ((12.0 if i % 2 == 0 else -7.0) if jolt_t is not None and abs(t - jolt_t) < 0.1 else 0.0)
        out.append(Sample(t, rng.gauss(0, 0.1), rng.gauss(0, 0.1), az))
    for k in range(int(duration) + 1):
        p = line.interpolate(min(k * speed, line.length))
        lon, lat = xy_to_lonlat(p.x, p.y)
        out.append(Sample(float(k), lat=lat, lon=lon, gps_accuracy_m=4.0, speed_m_s=speed))
    out.sort(key=lambda s: s.t)
    return out


def test_windows_and_matching_direction():
    line = LineString([(X0, Y0), (X0 + 90, Y0)])  # ride east along a 90 m edge
    samples = _ride_along(line, jolt_t=50.0)
    windows = make_windows(samples, CFG)
    assert 95 <= len(windows) <= 101
    w50 = next(w for w in windows if w.t0 <= 50.0 < w.t1)
    assert w50.peak > CFG["jolt_peak_threshold_m_s2"] and all(w.rms < CFG["smooth_rms_threshold_m_s2"] for w in windows if abs(w.t0 - 50) > 2)
    assert w50.heading_deg == pytest.approx(90.0, abs=5) and w50.speed_m_s == pytest.approx(0.9, abs=0.05)
    from api.models import FootpathEdge as FE
    from common.crs import to_wgs84

    along = FE(u=1, v=2, geom_wkt=to_wgs84(line).wkt, geom_m_wkt=line.wkt, length_m=90.0, kind="sidewalk", side="L")
    along.id = 1
    cross_geom = LineString([(X0 + 45, Y0 - 30), (X0 + 45, Y0 + 30)])  # a crossing-direction edge through the middle
    cross = FE(u=3, v=4, geom_wkt=to_wgs84(cross_geom).wkt, geom_m_wkt=cross_geom.wkt, length_m=60.0, kind="crossing", side="none")
    cross.id = 2
    idx = EdgeIndex([cross, along])  # the crossing is listed first and is nearer at t=50
    match_windows(windows, idx, CFG)
    matched = [w for w in windows if w.edge_id is not None]
    assert matched and all(w.edge_id == 1 for w in matched)  # direction agreement rejects the perpendicular edge
    tr = traversals(windows)
    assert len(tr) == 1 and tr[0].edge_id == 1 and tr[0].covered_fraction(90.0) >= 0.95
    # a stationary window (speed 0) is not matched
    still = make_windows([Sample(i / 50, 0, 0, 9.81) for i in range(100)] + [Sample(0.0, lat=28.65, lon=77.3, speed_m_s=0.0), Sample(2.0, lat=28.65, lon=77.3, speed_m_s=0.0)], CFG)
    match_windows(still, idx, CFG)
    assert all(w.edge_id is None for w in still)


@pytest.fixture(scope="module")
def api_db(toy_db, tmp_path_factory):
    path = tmp_path_factory.mktemp("ridedb") / "rides.sqlite"
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


def test_ride_api_flips_unknown_edge_to_verified_by_wheels(client, api_db):
    user = client.post("/users", json={"display_name": "rider", "profile": "wheelchair_manual"}).json()
    with Session(get_engine(api_db)) as s:
        edge = next(e for e in s.exec(select(FootpathEdge)).all() if e.state == "unknown" and e.kind == "sidewalk" and e.length_m >= 60)
        from shapely import wkt
        line = wkt.loads(edge.geom_m_wkt)
    samples = _ride_along(line, jolt_t=None)
    r = client.post("/rides", json={"user_id": user["id"], "started_at": "2026-10-24T09:00:00Z", "device": "test"})
    assert r.status_code == 201 and r.json()["status"] == "active"
    rid = r.json()["id"]
    # upload in 10 s batches like the phone does
    for start in range(0, int(samples[-1].t) + 1, 10):
        batch = [s.__dict__ for s in samples if start <= s.t < start + 10]
        assert client.post(f"/rides/{rid}/samples", json={"samples": batch}).status_code == 200
    assert client.get(f"/rides/{rid}").json()["n_samples"] == len(samples)
    summary = client.post(f"/rides/{rid}/end", json={"ended_at": "2026-10-24T09:05:00Z"}).json()
    assert summary["status"] == "processed" and summary["edges_verified_by_wheels"] >= 1 and edge.id in summary["verified_edge_ids"]
    assert summary["jolts"] == 0 and summary["synthetic"] is False
    with Session(get_engine(api_db)) as s:
        e = s.get(FootpathEdge, edge.id)
        assert e.state == "clear" and e.observed_by == "wheel" and e.state_synthetic is False
        cov = s.exec(select(Coverage).where(Coverage.edge_id == edge.id, Coverage.source == "wheel")).first()
        assert cov is not None and cov.observed and not cov.synthetic
        st = s.exec(select(EdgeRideStat).where(EdgeRideStat.edge_id == edge.id)).one()
        assert st.verified_by_wheels and st.n_traversals == 1 and 0 < st.roughness_index < CFG["smooth_rms_threshold_m_s2"]
    fc = client.get("/layers/wheels").json()
    f = next(f for f in fc["features"] if f["properties"].get("edge_id") == edge.id)
    assert f["properties"]["verified_by_wheels"] is True and f["geometry"]["type"] == "LineString"
    assert client.post(f"/rides/{rid}/samples", json={"samples": []}).status_code == 400  # ended
    assert client.post(f"/rides/{rid}/end", json={}).json()["status"] == "processed"      # idempotent
    assert client.get("/rides/9999").status_code == 404


def test_rough_ride_does_not_verify_and_jolt_makes_suspected_barrier(client, api_db):
    user = client.post("/users", json={"display_name": "rider2", "profile": "wheelchair_manual"}).json()
    with Session(get_engine(api_db)) as s:
        edge = next(e for e in s.exec(select(FootpathEdge)).all() if e.state == "unknown" and e.kind == "sidewalk" and e.length_m >= 60
                    and not s.exec(select(EdgeRideStat).where(EdgeRideStat.edge_id == e.id)).first())
        from shapely import wkt
        line = wkt.loads(edge.geom_m_wkt)
        n_barriers = len(s.exec(select(Barrier)).all())
    samples = _ride_along(line, rms=2.5, jolt_t=line.length / 0.9 / 2, seed=3)  # rough + a jolt mid-way
    rid = client.post("/rides", json={"user_id": user["id"]}).json()["id"]
    client.post(f"/rides/{rid}/samples", json={"samples": [s.__dict__ for s in samples]})
    summary = client.post(f"/rides/{rid}/end", json={}).json()
    assert summary["edges_verified_by_wheels"] == 0 and summary["jolts"] >= 1
    with Session(get_engine(api_db)) as s:
        assert s.get(FootpathEdge, edge.id).state == "unknown"
        barriers = s.exec(select(Barrier)).all()
        new = [b for b in barriers if b.status == "suspected"]
        assert len(barriers) == n_barriers + len(new) and new and new[0].class_id == CFG["jolt_class"]
        assert new[0].edge_id == edge.id and not new[0].synthetic and "jolt" in new[0].tags
    jolts = [f for f in client.get("/layers/wheels").json()["features"] if f["properties"].get("kind") == "jolt"]
    assert jolts and jolts[0]["properties"]["peak_m_s2"] > CFG["jolt_peak_threshold_m_s2"]
    # suspected barriers never enter routing
    r = client.get("/route", params={"demo": "riya"}).json()
    assert all(b["id"] != new[0].id for rt in r["routes"].values() if rt for b in rt["barriers"])


def test_replay_demo_is_synthetic_and_verifies_edges(client, api_db):
    user = client.post("/users", json={"display_name": "demo", "profile": "walker"}).json()
    summary = client.post("/rides/replay-demo", json={"user_id": user["id"]}).json()
    assert summary["synthetic"] is True and summary["edges_verified_by_wheels"] >= 3 and summary["jolts"] >= 1
    with Session(get_engine(api_db)) as s:
        ride = s.get(Ride, summary["id"])
        assert ride.synthetic and ride.device == "synthetic demo replay"
        for eid in summary["verified_edge_ids"]:
            e = s.get(FootpathEdge, eid)
            assert e.state != "unknown" and e.observed_by == "wheel"  # blocked stays blocked when a barrier sits on it
            cov = s.exec(select(Coverage).where(Coverage.edge_id == eid, Coverage.source == "wheel")).first()
            assert cov.synthetic is True
        assert all(s.get(Barrier, bid).synthetic for bid in summary["jolt_barrier_ids"])


def test_synthetic_ride_generator_shape():
    line = LineString([(X0, Y0), (X0 + 45, Y0), (X0 + 45, Y0 + 45)])
    samples = synthetic_ride_samples([line], CFG, jolt_at_fraction=0.5)
    acc = [s for s in samples if s.az is not None]
    gps = [s for s in samples if s.lat is not None]
    assert len(acc) == int(90 / CFG["demo_ride"]["speed_m_s"] * CFG["accel_hz"]) and len(gps) == int(90 / CFG["demo_ride"]["speed_m_s"]) + 1
    assert max(s.az for s in acc) > 9.81 + CFG["demo_ride"]["jolt_peak_m_s2"] * 0.9


def test_pick_thresholds():
    lw = {"smooth": [(0.3 + 0.01 * i, 1.0 + 0.05 * i) for i in range(40)],
          "broken": [(1.5 + 0.02 * i, 4.0 + 0.1 * i) for i in range(40)],
          "kerb": [(2.0, 9.0 + 0.1 * i) for i in range(20)]}
    res = pick_thresholds(lw)
    assert 0.7 < res["smooth_rms_threshold_m_s2"] < 1.5 and res["rms_separable"] is True
    assert 7.0 < res["jolt_peak_threshold_m_s2"] < 9.5 and res["peak_separable"] is True
    assert res["n_windows"] == {"smooth": 40, "broken": 40, "kerb": 20}
