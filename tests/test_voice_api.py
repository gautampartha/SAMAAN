"""Listen conversation endpoint with a fake model: config on/off, tool loop (find_place runs on the
server, start_navigation comes back as an action), report_barrier creates a pending report, model
failure -> 502, no key -> 503."""
from __future__ import annotations

import json
import os
import shutil
import urllib.error

import pytest
from fastapi.testclient import TestClient

from api.services import voice_llm
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


class FakeModel:
    """Scripted assistant messages, returned in order; records the request bodies."""

    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.bodies = []

    def __call__(self, url, key, body, timeout):
        self.bodies.append(body)
        if not self.scripts:
            raise AssertionError("model called more times than scripted")
        nxt = self.scripts.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return {"choices": [{"message": nxt}]}


def tool_call(name, args, cid="c1"):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")


def test_config_reflects_env(client, monkeypatch):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    r = client.get("/voice/config").json()
    assert r["enabled"] is False and r["provider"] is None
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")
    r = client.get("/voice/config").json()
    assert r["enabled"] is True and r["provider"] == "nvidia" and "find_place" in r["tools"] and r["model"]


def test_chat_without_key_is_503(client, monkeypatch):
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    assert client.post("/voice/chat", json={"messages": [{"role": "user", "content": "hi"}]}).status_code == 503


def test_find_place_then_navigate(client, key, monkeypatch):
    anchors = client.get("/layers/anchors").json()["features"]
    name = anchors[0]["properties"]["name_en"]
    fake = FakeModel([
        {"role": "assistant", "content": None, "tool_calls": [tool_call("find_place", {"query": name.split()[0]})]},
        {"role": "assistant", "content": f"Found {name}. Shall I start?"},
    ])
    monkeypatch.setattr(voice_llm, "_post", fake)
    r = client.post("/voice/chat", json={"messages": [{"role": "user", "content": f"take me to {name}"}], "lang": "en"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["reply"].startswith("Found") and d["actions"] == []
    assert "Top match" in d["memory"] and "lat" in d["memory"]
    assert d["tool_log"][0]["name"] == "find_place" and "Top match" in d["tool_log"][0]["result"]
    # the tool result went back to the model as a tool message
    roles = [m["role"] for m in fake.bodies[1]["messages"]]
    assert roles[-1] == "tool" and roles[-2] == "assistant"
    # second utterance: the model starts navigation -> action for the app, default sentence when it says nothing
    fake2 = FakeModel([
        {"role": "assistant", "content": None, "tool_calls": [tool_call("start_navigation", {"lat": 1.0, "lon": 2.0, "name": name})]},
        {"role": "assistant", "content": ""},
    ])
    monkeypatch.setattr(voice_llm, "_post", fake2)
    d = client.post("/voice/chat", json={"messages": [{"role": "user", "content": "yes"}], "lang": "en"}).json()
    assert d["actions"] == [{"name": "start_navigation", "args": {"lat": 1.0, "lon": 2.0, "name": name}}]
    assert name in d["reply"]


def test_report_barrier_creates_pending_report(client, key, monkeypatch):
    z = config.zone()["center"]
    u = client.post("/users", json={"display_name": "meera", "profile": "blind_low_vision", "language": "en"}).json()
    fake = FakeModel([
        {"role": "assistant", "content": None, "tool_calls": [tool_call("report_barrier", {"class_id": "parked_vehicle", "note": "scooter"})]},
        {"role": "assistant", "content": "Reported a parked vehicle. Thank you."},
    ])
    monkeypatch.setattr(voice_llm, "_post", fake)
    body = {"messages": [{"role": "user", "content": "a scooter blocks the path"}], "lang": "en", "user_id": u["id"],
            "location": {"lat": z["lat"], "lon": z["lon"]}}
    d = client.post("/voice/chat", json=body).json()
    assert "sent" in d["tool_log"][0]["result"]
    listed = [r for r in client.get("/reports?status=pending&limit=50").json()["results"] if r["class_id"] == "parked_vehicle"]
    assert len(listed) == 1 and listed[0]["photo_url"] is None


def test_report_without_location_tells_the_model(client, key, monkeypatch):
    fake = FakeModel([
        {"role": "assistant", "content": None, "tool_calls": [tool_call("report_barrier", {"class_id": "open_drain"})]},
        {"role": "assistant", "content": "I need your location first."},
    ])
    monkeypatch.setattr(voice_llm, "_post", fake)
    d = client.post("/voice/chat", json={"messages": [{"role": "user", "content": "report a drain"}]}).json()
    assert "location is unknown" in d["tool_log"][0]["result"]


def test_model_failure_is_502_and_falls_through_models(client, key, monkeypatch):
    err = urllib.error.HTTPError("u", 404, "nf", {}, None)
    n = len(voice_llm.vcfg()["models"])
    fake = FakeModel([err] * n)
    monkeypatch.setattr(voice_llm, "_post", fake)
    r = client.post("/voice/chat", json={"messages": [{"role": "user", "content": "hello"}]})
    assert r.status_code == 502 and len(fake.bodies) == n
