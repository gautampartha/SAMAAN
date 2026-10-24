"""On-demand zones: config override merge, validation, switch-back; the OSM build itself is not
run in tests (network)."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from common import config


def test_zone_override_merges_and_clears(tmp_path, monkeypatch):
    f = tmp_path / "active_zone.json"
    monkeypatch.setenv(config.ACTIVE_ZONE_FILE_ENV, str(f))
    config.clear_cache()
    base = config.zone()
    f.write_text(json.dumps({"name": "testtown", "display_name": {"en": "Test Town", "hi": "टेस्ट टाउन"},
                             "bbox": {"south": 1, "west": 2, "north": 3, "east": 4}, "center": {"lat": 2, "lon": 3},
                             "anchors": [], "raw_cache": "data/raw/zone_testtown.osm"}))
    z = config.zone()
    assert z["name"] == "testtown" and z["bbox"]["north"] == 3 and z["osm"]["raw_cache"] == "data/raw/zone_testtown.osm"
    assert z["on_demand"] is True and z["basemap"] == base["basemap"] and z["crs"] == base["crs"]
    f.unlink()
    assert config.zone()["name"] == base["name"]


@pytest.fixture(scope="module")
def client(toy_db):
    from api.main import app

    with TestClient(app) as c:
        yield c


def test_rebuild_validation_and_status(client, tmp_path, monkeypatch):
    monkeypatch.setenv(config.ACTIVE_ZONE_FILE_ENV, str(tmp_path / "active.json"))
    bad = client.post("/zones/rebuild", json={"name": "x", "bbox": {"south": 1, "west": 2, "north": 3, "east": 4}})
    assert bad.status_code == 422  # name too short / area too large
    too_big = client.post("/zones/rebuild", json={"name": "bigcity", "bbox": {"south": 26.0, "west": 75.0, "north": 27.0, "east": 76.0}})
    assert too_big.status_code == 422 and "too large" in too_big.json()["detail"]
    inverted = client.post("/zones/rebuild", json={"name": "upside", "bbox": {"south": 26.9, "west": 75.6, "north": 26.8, "east": 75.7}})
    assert inverted.status_code == 422
    st = client.get("/zones/status").json()
    assert st["building"] is False and st["active"]["name"] == config.zone()["name"]
    assert "zones" in client.get("/zones").json()
    assert client.post("/zones/reset").json()["status"] == "reset"
