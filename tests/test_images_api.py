"""POST /images upload, photo serving, images layer, coverage recompute endpoint."""
from __future__ import annotations

import base64
import os
import shutil

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from api.db import get_engine
from api.models import Image
from api.routers.images import own_photo_dir

# 1x1 white JPEG (standard minimal baseline file)
TINY_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/"
    "yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="
)


@pytest.fixture(scope="module")
def api_db(toy_db, tmp_path_factory):
    """A private copy of the seeded toy DB, so uploads here never touch the shared fixture."""
    path = tmp_path_factory.mktemp("imgdb") / "images.sqlite"
    shutil.copy(toy_db, path)
    previous = os.environ.get("SAMAAN_DB")
    os.environ["SAMAAN_DB"] = str(path)
    yield path
    os.environ["SAMAAN_DB"] = previous or ""
    shutil.rmtree(own_photo_dir() / "test-walk", ignore_errors=True)


@pytest.fixture(scope="module")
def client(api_db):
    from api.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture()
def api_session(api_db):
    with Session(get_engine(api_db)) as s:
        yield s


def test_upload_creates_row_and_file(client, api_session):
    z = client.get("/zone").json()["center"]
    r = client.post("/images", files={"photo": ("p.jpg", TINY_JPEG, "image/jpeg")},
                    data={"lat": z["lat"], "lon": z["lon"], "gps_accuracy_m": 6.5, "heading_deg": 372.0,
                          "pitch_deg": -3.0, "hfov_deg": 70, "captured_at": "2026-10-24T09:30:00Z",
                          "session_id": "test-walk", "note": "left side", "width": 1, "height": 1,
                          "heading_source": "absolute"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["heading_deg"] == 12.0 and body["session_id"] == "test-walk" and body["bytes"] == len(TINY_JPEG)
    img = api_session.get(Image, body["id"])
    assert img.source == "own" and img.synthetic is False and img.path.startswith("data/raw/own/test-walk/")
    photo = client.get(f"/images/{body['id']}/photo")
    assert photo.status_code == 200 and photo.content == TINY_JPEG
    meta = client.get(f"/images/{body['id']}").json()
    assert meta["has_photo"] is True and meta["hfov_deg"] == 70


def test_upload_rejects_bad_input(client):
    z = client.get("/zone").json()["center"]
    bad = client.post("/images", files={"photo": ("p.txt", b"hello", "text/plain")}, data={"lat": z["lat"], "lon": z["lon"]})
    assert bad.status_code == 415
    empty = client.post("/images", files={"photo": ("p.jpg", b"", "image/jpeg")}, data={"lat": z["lat"], "lon": z["lon"]})
    assert empty.status_code == 422
    rng = client.post("/images", files={"photo": ("p.jpg", TINY_JPEG, "image/jpeg")}, data={"lat": 95, "lon": z["lon"]})
    assert rng.status_code == 422


def test_images_layer_and_recompute(client, api_session):
    fc = client.get("/layers/images").json()
    assert fc["type"] == "FeatureCollection" and fc["count"] >= 1
    f = next(f for f in fc["features"] if f["properties"]["session_id"] == "test-walk")
    assert f["properties"]["has_photo"] is True and f["properties"]["source"] == "own" and f["properties"]["synthetic"] is False
    assert client.get("/layers/images?source=mapillary").json()["count"] == 0
    r = client.post("/coverage/recompute")
    assert r.status_code == 200
    body = r.json()
    assert body["coverage"]["images_total"] >= 1 and set(body["states"]) >= {"clear", "blocked", "unknown"}
    # the seeded overlay is still intact: the toy graph still has synthetic states
    assert body["states"]["from_seed_coverage"] > 0
    assert len(api_session.exec(select(Image)).all()) >= 1
