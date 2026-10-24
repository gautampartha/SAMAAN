"""Vapi tool webhook on a private copy of the toy DB: config off without a key, find_place,
report_barrier (creates a pending report at the traveller's location), navigation acknowledgements,
non tool-call messages ignored."""
from __future__ import annotations

import os
import shutil

import pytest
from fastapi.testclient import TestClient

from api.services.reports import REPORT_DIR
from common import config


@pytest.fixture(scope="module")
def api_db(toy_db, tmp_path_factory):
    path = tmp_path_factory.mktemp("voicedb") / "voice.sqlite"
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
    for r in REPORT_DIR.glob("*.jpg"):
        r.unlink(missing_ok=True)


def _tool_call(name: str, args: dict, variables: dict | None = None, call_id: str = "tc1") -> dict:
    return {
        "message": {
            "type": "tool-calls",
            "toolCallList": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": args}}],
            "call": {"assistantOverrides": {"variableValues": variables or {}}},
        }
    }


def test_config_reflects_env(client, monkeypatch):
    monkeypatch.delenv("VAPI_PUBLIC_KEY", raising=False)
    r = client.get("/voice/config")
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["public_key"] is None
    monkeypatch.setenv("VAPI_PUBLIC_KEY", "pk-test")
    r = client.get("/voice/config").json()
    assert r["enabled"] is True and r["public_key"] == "pk-test" and "find_place" in r["tools"]


def test_find_place_returns_top_match(client):
    anchors = client.get("/layers/anchors").json()["features"]
    name = anchors[0]["properties"]["name_en"]
    r = client.post("/voice/tools", json=_tool_call("find_place", {"query": name.split()[0]}))
    assert r.status_code == 200
    res = r.json()["results"][0]
    assert res["toolCallId"] == "tc1"
    assert "Top match" in res["result"] and "lat" in res["result"]


def test_find_place_unknown(client):
    res = client.post("/voice/tools", json=_tool_call("find_place", {"query": "zzqxv"})).json()["results"][0]
    assert "No place" in res["result"]


def test_report_barrier_creates_pending_report(client):
    z = config.zone()["center"]
    u = client.post("/users", json={"display_name": "meera", "profile": "blind_low_vision", "language": "en"}).json()
    body = _tool_call("report_barrier", {"class_id": "parked_vehicle", "note": "scooter across the path"},
                      variables={"lat": z["lat"], "lon": z["lon"], "user_id": u["id"], "lang": "en"})
    res = client.post("/voice/tools", json=body).json()["results"][0]
    assert "sent" in res["result"] and "parked_vehicle" in res["result"]
    listed = [r for r in client.get("/reports?status=pending&limit=50").json()["results"] if r["class_id"] == "parked_vehicle"]
    assert len(listed) == 1 and listed[0]["photo_url"] is None


def test_report_without_location_fails_gracefully(client):
    res = client.post("/voice/tools", json=_tool_call("report_barrier", {"class_id": "open_drain"})).json()["results"][0]
    assert "location is unknown" in res["result"]


def test_navigation_tools_ack_and_other_messages_ignored(client):
    res = client.post("/voice/tools", json=_tool_call("start_navigation", {"lat": 1, "lon": 2, "name": "x"})).json()["results"][0]
    assert res["result"] == "ok"
    assert client.post("/voice/tools", json={"message": {"type": "status-update"}}).json() == {"results": []}
