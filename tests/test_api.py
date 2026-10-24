import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api.models import Barrier, FootpathEdge


@pytest.fixture(scope="module")
def client(toy_db):
    from api.main import app

    with TestClient(app) as c:
        yield c


def _check_fc(fc, geom_types):
    assert fc["type"] == "FeatureCollection"
    assert fc["count"] == len(fc["features"])
    assert "osm" in fc["attribution"]
    for f in fc["features"]:
        assert f["type"] == "Feature"
        assert f["geometry"]["type"] in geom_types
        assert "synthetic" in f["properties"]


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["synthetic"] is True
    assert body["graph_edges"] > 0


def test_zone(client):
    z = client.get("/zone").json()
    assert z["name"] == "karkarduma"
    assert set(z["bbox"]) == {"south", "west", "north", "east"}
    assert z["display_name"]["hi"] and z["display_name"]["en"]
    assert z["basemap"]["style_url"].startswith("https://")


def test_footpaths_layer(client, db_session):
    fc = client.get("/layers/footpaths").json()
    _check_fc(fc, {"LineString"})
    assert fc["count"] == len(db_session.exec(select(FootpathEdge)).all())
    states = {f["properties"]["state"] for f in fc["features"]}
    assert states <= {"clear", "blocked", "unknown"} and "blocked" in states and "unknown" in states
    assert fc["synthetic"] is True


def test_barriers_layer(client, db_session):
    fc = client.get("/layers/barriers").json()
    _check_fc(fc, {"Point"})
    assert fc["count"] == len(db_session.exec(select(Barrier)).all())
    f = fc["features"][0]["properties"]
    for key in ("class", "name_en", "name_hi", "severity", "tags", "permanent", "status", "edge_id"):
        assert key in f
    assert all(f["properties"]["synthetic"] for f in fc["features"])
    lon, lat = fc["features"][0]["geometry"]["coordinates"]
    assert 77 < lon < 78 and 28 < lat < 29


def test_coverage_layer(client):
    fc = client.get("/layers/coverage").json()
    _check_fc(fc, {"LineString"})
    observed = [f for f in fc["features"] if f["properties"]["observed"]]
    assert 0 < len(observed) < fc["count"]
    assert all(f["properties"]["n_images"] >= 2 for f in observed)


def test_anchors_layer(client):
    fc = client.get("/layers/anchors").json()
    _check_fc(fc, {"Point"})
    ids = {f["properties"]["id"] for f in fc["features"]}
    assert "metro_karkarduma" in ids
    assert all(f["properties"]["verified"] is False for f in fc["features"])


def test_demo_layer(client):
    fc = client.get("/layers/demo").json()
    roles = sorted(f["properties"]["role"] for f in fc["features"])
    assert roles == ["destination", "origin", "path"]
    path = next(f for f in fc["features"] if f["properties"]["role"] == "path")
    assert path["geometry"]["type"] == "LineString" and path["properties"]["length_m"] > 0
    assert fc["synthetic"] is True
