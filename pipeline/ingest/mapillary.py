"""Mapillary API v4 downloader (plan 6.2). Licence-clean imagery with attribution stored per image.

    MAPILLARY_TOKEN=MLY|... python -m pipeline.ingest.mapillary [--download] [--max N]

Requires a free Mapillary developer token (human task). Images in the zone bbox are stored in
the `image` table with source="mapillary"; thumbnails (2048 px) are optionally downloaded to
data/raw/mapillary/<id>.jpg (URLs expire, so download when ingesting). No Google imagery.
"""
from __future__ import annotations

import argparse
import logging
import math
import os
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import requests
from sqlmodel import Session, select

from api.db import init_db
from api.models import Image
from common import config
from common.paths import ROOT

log = logging.getLogger(__name__)
USER_AGENT = "SAMAAN-hackathon/0.0.1 (SC-02 accessible routing)"
Fetch = Callable[[str, dict[str, Any]], dict[str, Any]]


def _http_fetch(url: str, params: dict[str, Any]) -> dict[str, Any]:
    r = requests.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=60)
    r.raise_for_status()
    return r.json()


def iter_images(token: str, bbox: tuple[float, float, float, float], mcfg: dict[str, Any],
                fetch: Fetch = _http_fetch, max_images: int | None = None) -> Iterator[dict[str, Any]]:
    """Yield raw Mapillary image dicts for the bbox (west, south, east, north), following paging."""
    url = mcfg["api_url"]
    params: dict[str, Any] = {"access_token": token, "fields": ",".join(mcfg["fields"]),
                              "bbox": ",".join(f"{v:.6f}" for v in bbox), "limit": int(mcfg["page_limit"])}
    n = 0
    while True:
        page = fetch(url, params)
        for item in page.get("data", []):
            yield item
            n += 1
            if max_images and n >= max_images:
                return
        nxt = (page.get("paging") or {}).get("next")
        if not nxt:
            return
        url, params = nxt, {}  # `next` is a full URL including the token


def hfov_from_camera(item: dict[str, Any], default_hfov: float, spherical_hfov: float) -> float:
    """Horizontal field of view from Mapillary camera_parameters [focal, k1, k2] (focal is
    normalised by the larger image dimension), or 360 for panoramas."""
    if item.get("is_pano") or item.get("camera_type") == "spherical":
        return spherical_hfov
    params = item.get("camera_parameters") or []
    focal = params[0] if params else None
    if not focal or focal <= 0:
        return default_hfov
    w, h = item.get("width"), item.get("height")
    scale = (w / max(w, h)) if (w and h) else 1.0  # focal is relative to max(w, h)
    return float(math.degrees(2 * math.atan(0.5 * scale / focal)))


def to_image_row(item: dict[str, Any], mcfg: dict[str, Any], cov: dict[str, Any]) -> Image | None:
    geom = item.get("computed_geometry") or item.get("geometry")
    if not geom or geom.get("type") != "Point":
        return None
    lon, lat = geom["coordinates"]
    if item.get("computed_compass_angle") is not None:
        heading, hsrc = float(item["computed_compass_angle"]), "mapillary_computed"
    elif item.get("compass_angle") is not None:
        heading, hsrc = float(item["compass_angle"]), "mapillary_compass"
    else:
        heading, hsrc = None, "none"
    captured = item.get("captured_at")
    captured_at = datetime.fromtimestamp(captured / 1000.0, tz=UTC) if captured else None
    creator = (item.get("creator") or {}).get("username") or "unknown"
    attribution = mcfg["attribution_template"].format(id=item["id"], creator=creator, licence=mcfg["licence"])
    return Image(
        source="mapillary", source_id=str(item["id"]), lat=float(lat), lon=float(lon),
        heading_deg=heading, heading_source=hsrc, pitch_deg=None,
        hfov_deg=hfov_from_camera(item, float(cov["default_hfov_deg"]), float(cov["spherical_hfov_deg"])),
        captured_at=captured_at, width=item.get("width"), height=item.get("height"),
        sequence_id=item.get("sequence"), camera_type=item.get("camera_type"), creator=creator,
        url=item.get("thumb_2048_url"), attribution=attribution, synthetic=False,
    )


def download_thumb(url: str, dest: Path) -> bool:
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=60)
        r.raise_for_status()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        return True
    except requests.RequestException as exc:  # pragma: no cover - network
        log.warning("thumbnail download failed for %s: %s", dest.name, exc)
        return False


def ingest(session: Session, token: str, zone_cfg: dict[str, Any] | None = None, pipeline_cfg: dict[str, Any] | None = None,
           fetch: Fetch = _http_fetch, download: bool = False, max_images: int | None = None) -> dict[str, int]:
    zone_cfg = zone_cfg or config.zone()
    pipeline_cfg = pipeline_cfg or config.pipeline()
    mcfg, cov = pipeline_cfg["mapillary"], pipeline_cfg["coverage"]
    existing = {i.source_id for i in session.exec(select(Image).where(Image.source == "mapillary")).all()}
    stats = {"seen": 0, "new": 0, "skipped_existing": 0, "no_geometry": 0, "downloaded": 0}
    thumb_dir = ROOT / mcfg["thumb_dir"]
    for item in iter_images(token, config.bbox_tuple(zone_cfg), mcfg, fetch=fetch, max_images=max_images):
        stats["seen"] += 1
        if str(item.get("id")) in existing:
            stats["skipped_existing"] += 1
            continue
        row = to_image_row(item, mcfg, cov)
        if row is None:
            stats["no_geometry"] += 1
            continue
        if download and row.url:
            dest = thumb_dir / f"{row.source_id}.jpg"
            if download_thumb(row.url, dest):
                row.path = str(dest.relative_to(ROOT))
                stats["downloaded"] += 1
        session.add(row)
        existing.add(row.source_id)
        stats["new"] += 1
    session.commit()
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--download", action="store_true", help="also download 2048 px thumbnails")
    ap.add_argument("--max", type=int, default=None, help="stop after N images (testing)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    token = os.environ.get("MAPILLARY_TOKEN")
    if not token:
        raise SystemExit("set MAPILLARY_TOKEN (Mapillary developer token, see docs/PROGRESS.md human tasks)")
    with Session(init_db()) as session:
        stats = ingest(session, token, download=args.download, max_images=args.max)
    print("mapillary ingest:", stats)


if __name__ == "__main__":
    main()
