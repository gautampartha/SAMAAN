"""Import a folder of phone photos (JPEG/HEIC with EXIF GPS) as own-photo coverage.

    python -m pipeline.ingest.import_photos --dir ~/Downloads/campus-walk [--api http://127.0.0.1:8000]
        [--session walk-2026-10-25] [--dry-run]

For each photo: lat/lon from the EXIF GPS IFD, heading from GPSImgDirection (iPhones write it),
capture time from DateTimeOriginal, then POST /images (source=own, heading_source=exif). HEIC is
converted with macOS `sips` first. Photos without GPS are skipped and listed. The API recomputes
coverage and states after every upload; run `make infer-zero-shot && make geolocate` afterwards
for detections and barriers, then POST /route/reload.
"""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import tempfile
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

GPS_IFD = 0x8825
EXIF_IFD = 0x8769
TAG_DATETIME_ORIGINAL = 0x9003
TAG_GPS_LAT_REF, TAG_GPS_LAT, TAG_GPS_LON_REF, TAG_GPS_LON = 1, 2, 3, 4
TAG_GPS_IMG_DIR_REF, TAG_GPS_IMG_DIR = 16, 17
TAG_GPS_HPOS_ERR = 31
SUPPORTED = {".jpg", ".jpeg", ".heic", ".heif", ".png"}


@dataclass
class PhotoMeta:
    lat: float
    lon: float
    heading_deg: float | None
    accuracy_m: float | None
    captured_at: datetime | None
    width: int
    height: int


def _ratio(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def dms_to_deg(dms: Any, ref: str | None) -> float | None:
    """EXIF (deg, min, sec) rationals -> signed decimal degrees."""
    try:
        d, m, s = (_ratio(x) for x in dms)
    except (TypeError, ValueError):
        return None
    if d is None or m is None or s is None:
        return None
    deg = d + m / 60.0 + s / 3600.0
    if ref and str(ref).upper() in ("S", "W"):
        deg = -deg
    return deg


def parse_gps(gps: dict[int, Any]) -> tuple[float, float] | None:
    lat = dms_to_deg(gps.get(TAG_GPS_LAT), gps.get(TAG_GPS_LAT_REF))
    lon = dms_to_deg(gps.get(TAG_GPS_LON), gps.get(TAG_GPS_LON_REF))
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if lat == 0 and lon == 0:
        return None
    return lat, lon


def parse_heading(gps: dict[int, Any]) -> float | None:
    h = _ratio(gps.get(TAG_GPS_IMG_DIR))
    if h is None:
        return None
    # 'M' = magnetic north; the few degrees of declination in India are below GPS noise.
    return h % 360.0


def parse_datetime(exif: dict[int, Any]) -> datetime | None:
    raw = exif.get(TAG_DATETIME_ORIGINAL)
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw), "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def to_jpeg(path: Path, tmp_dir: Path) -> Path:
    """HEIC -> JPEG via macOS sips (keeps EXIF); other formats are returned as-is."""
    if path.suffix.lower() not in (".heic", ".heif"):
        return path
    if platform.system() != "Darwin":
        raise RuntimeError("HEIC needs macOS sips or a prior conversion to JPEG")
    out = tmp_dir / (path.stem + ".jpg")
    subprocess.run(["sips", "-s", "format", "jpeg", str(path), "--out", str(out)], check=True, capture_output=True)
    return out


def read_meta(path: Path) -> PhotoMeta | None:
    with Image.open(path) as im:
        exif = im.getexif()
        gps = exif.get_ifd(GPS_IFD) or {}
        pos = parse_gps(dict(gps))
        if pos is None:
            return None
        sub = exif.get_ifd(EXIF_IFD) or {}
        im_t = ImageOps.exif_transpose(im)
        w, h = im_t.size
        return PhotoMeta(
            lat=pos[0],
            lon=pos[1],
            heading_deg=parse_heading(dict(gps)),
            accuracy_m=_ratio(gps.get(TAG_GPS_HPOS_ERR)),
            captured_at=parse_datetime(dict(sub)) or parse_datetime(dict(exif)),
            width=w,
            height=h,
        )


def _multipart(fields: dict[str, str], file_name: str, data: bytes) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    body = bytearray()
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"{file_name}\"\r\nContent-Type: image/jpeg\r\n\r\n".encode()
    body += data + f"\r\n--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def upload(api: str, jpeg: Path, meta: PhotoMeta, session_id: str) -> dict[str, Any]:
    fields = {
        "lat": f"{meta.lat:.7f}",
        "lon": f"{meta.lon:.7f}",
        "source": "own",
        "session_id": session_id,
        "width": str(meta.width),
        "height": str(meta.height),
        "note": "imported from phone photos (EXIF)",
    }
    if meta.heading_deg is not None:
        fields["heading_deg"] = f"{meta.heading_deg:.1f}"
        fields["heading_source"] = "absolute"
    if meta.accuracy_m is not None:
        fields["gps_accuracy_m"] = f"{meta.accuracy_m:.1f}"
    if meta.captured_at is not None:
        fields["captured_at"] = meta.captured_at.isoformat()
    body, ctype = _multipart(fields, jpeg.name, jpeg.read_bytes())
    req = urllib.request.Request(f"{api.rstrip('/')}/images", data=body, method="POST", headers={"Content-Type": ctype, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:  # noqa: S310 - local/own API
        return json.loads(resp.read().decode())


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, type=Path)
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--session", default=f"import-{datetime.now(timezone.utc):%Y%m%d-%H%M}")
    ap.add_argument("--dry-run", action="store_true", help="parse and print, do not upload")
    args = ap.parse_args(argv)

    files = sorted(p for p in args.dir.rglob("*") if p.suffix.lower() in SUPPORTED)
    if not files:
        print(f"no photos under {args.dir}", file=sys.stderr)
        return 1
    ok = skipped = failed = 0
    no_heading = 0
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        for p in files:
            try:
                jpeg = to_jpeg(p, tmp_dir)
                meta = read_meta(jpeg)
            except Exception as e:  # noqa: BLE001 - keep going through a folder
                print(f"FAIL  {p.name}: {e}")
                failed += 1
                continue
            if meta is None:
                print(f"SKIP  {p.name}: no GPS in EXIF")
                skipped += 1
                continue
            if meta.heading_deg is None:
                no_heading += 1
            line = f"{p.name}: {meta.lat:.6f},{meta.lon:.6f} heading={meta.heading_deg} acc={meta.accuracy_m} at={meta.captured_at}"
            if args.dry_run:
                print(f"OK    {line}")
                ok += 1
                continue
            try:
                res = upload(args.api, jpeg, meta, args.session)
                print(f"UP    {line} -> image {res.get('id')}")
                ok += 1
            except Exception as e:  # noqa: BLE001
                print(f"FAIL  {p.name}: {e}")
                failed += 1
    print(f"\n{ok} uploaded{' (dry run)' if args.dry_run else ''}, {skipped} without GPS, {failed} failed, {no_heading} without heading (coverage uses a wider cone for those)")
    print("next: make infer-zero-shot && make geolocate && curl -X POST %s/route/reload" % args.api.rstrip("/"))
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
