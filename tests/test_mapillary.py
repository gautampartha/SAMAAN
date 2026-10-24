"""Mapillary v4 parsing with a recorded-style fixture (no network)."""
from __future__ import annotations

from sqlmodel import Session, select

from api.db import reset_db
from api.models import Image
from common import config
from pipeline.ingest.mapillary import hfov_from_camera, ingest, iter_images, to_image_row

PIPE = config.pipeline()
MCFG, COV = PIPE["mapillary"], PIPE["coverage"]

PAGE1 = {"data": [
    {"id": "1001", "computed_geometry": {"type": "Point", "coordinates": [77.3050, 28.6480]},
     "geometry": {"type": "Point", "coordinates": [77.3051, 28.6481]}, "computed_compass_angle": 93.5,
     "compass_angle": 90.0, "captured_at": 1700000000000, "camera_parameters": [0.8, 0.0, 0.0],
     "camera_type": "perspective", "thumb_2048_url": "https://example.invalid/1001.jpg",
     "sequence": "seqA", "creator": {"username": "walker_42", "id": "1"}, "width": 4000, "height": 3000},
    {"id": "1002", "geometry": {"type": "Point", "coordinates": [77.3060, 28.6490]}, "compass_angle": 10.0,
     "captured_at": 1700000100000, "camera_type": "spherical", "is_pano": True,
     "thumb_2048_url": "https://example.invalid/1002.jpg", "sequence": "seqA", "creator": {"username": "walker_42"}},
    {"id": "1003", "captured_at": 1700000200000},  # no geometry -> skipped
], "paging": {"next": "https://graph.mapillary.com/images?after=abc&access_token=T"}}
PAGE2 = {"data": [
    {"id": "1004", "computed_geometry": {"type": "Point", "coordinates": [77.3070, 28.6500]},
     "captured_at": 1700000300000, "camera_type": "perspective"},
]}


def fake_fetch(calls):
    def _fetch(url, params):
        calls.append((url, dict(params)))
        return PAGE1 if "after=" not in url else PAGE2
    return _fetch


def test_iter_images_follows_paging():
    calls = []
    items = list(iter_images("T", (77.2993, 28.643, 77.3115, 28.6538), MCFG, fetch=fake_fetch(calls)))
    assert [i["id"] for i in items] == ["1001", "1002", "1003", "1004"]
    assert calls[0][1]["access_token"] == "T" and "bbox" in calls[0][1] and calls[0][1]["fields"].startswith("id,")
    assert calls[1][0].startswith("https://graph.mapillary.com/images?after=") and calls[1][1] == {}


def test_hfov_from_focal_and_pano():
    assert abs(hfov_from_camera({"camera_parameters": [0.8], "width": 4000, "height": 3000}, 65, 360) - 64.0) < 0.1
    assert hfov_from_camera({"is_pano": True}, 65, 360) == 360
    assert hfov_from_camera({"camera_parameters": []}, 65, 360) == 65


def test_to_image_row_fields_and_attribution():
    row = to_image_row(PAGE1["data"][0], MCFG, COV)
    assert row.source == "mapillary" and row.source_id == "1001"
    assert (row.lon, row.lat) == (77.3050, 28.6480)  # computed geometry preferred
    assert row.heading_deg == 93.5 and row.heading_source == "mapillary_computed"
    assert row.captured_at.year == 2023 and row.creator == "walker_42" and row.sequence_id == "seqA"
    assert "CC BY-SA 4.0" in row.attribution and "walker_42" in row.attribution and "1001" in row.attribution
    pano = to_image_row(PAGE1["data"][1], MCFG, COV)
    assert pano.hfov_deg == 360 and pano.heading_source == "mapillary_compass" and pano.camera_type == "spherical"
    assert to_image_row(PAGE1["data"][2], MCFG, COV) is None


def test_ingest_dedupes(tmp_path):
    engine = reset_db(tmp_path / "m.sqlite")
    with Session(engine) as s:
        stats = ingest(s, "T", fetch=fake_fetch([]))
        assert stats == {"seen": 4, "new": 3, "skipped_existing": 0, "no_geometry": 1, "downloaded": 0}
        stats = ingest(s, "T", fetch=fake_fetch([]))
        assert stats["new"] == 0 and stats["skipped_existing"] == 3
        rows = s.exec(select(Image)).all()
        assert len(rows) == 3 and all(not r.synthetic and r.attribution for r in rows)
