"""EXIF parsing for the phone-photo importer: DMS -> degrees, hemisphere signs, heading, timestamps,
and a round trip through a JPEG written with Pillow (GPS IFD)."""
from __future__ import annotations

from fractions import Fraction

from PIL import Image

from pipeline.ingest.import_photos import GPS_IFD, dms_to_deg, parse_gps, parse_heading, read_meta


def test_dms_and_hemispheres():
    assert abs(dms_to_deg((26, 50, 34.44), "N") - 26.84290) < 1e-5
    assert dms_to_deg((75, 33, 55.4), "W") < 0
    assert dms_to_deg("garbage", "N") is None
    assert parse_gps({1: "N", 2: (0, 0, 0), 3: "E", 4: (0, 0, 0)}) is None


def test_heading_wraps():
    assert parse_heading({17: Fraction(370, 1)}) == 10.0
    assert parse_heading({}) is None


def test_round_trip_jpeg(tmp_path):
    im = Image.new("RGB", (64, 48), "gray")
    exif = Image.Exif()
    gps = exif.get_ifd(GPS_IFD)
    gps[1] = "N"
    gps[2] = (Fraction(26), Fraction(50), Fraction(3444, 100))
    gps[3] = "E"
    gps[4] = (Fraction(75), Fraction(33), Fraction(5540, 100))
    gps[16] = "T"
    gps[17] = Fraction(1235, 10)
    exif[0x9003] = "2026:10:25 09:30:00"
    path = tmp_path / "walk.jpg"
    im.save(path, exif=exif.tobytes())
    meta = read_meta(path)
    assert meta is not None
    assert abs(meta.lat - 26.8429) < 1e-4 and abs(meta.lon - 75.5654) < 1e-4
    assert meta.heading_deg is not None and abs(meta.heading_deg - 123.5) < 1e-6
    assert meta.width == 64 and meta.height == 48
    assert meta.captured_at is not None and meta.captured_at.year == 2026


def test_no_gps_returns_none(tmp_path):
    path = tmp_path / "plain.jpg"
    Image.new("RGB", (8, 8)).save(path)
    assert read_meta(path) is None
