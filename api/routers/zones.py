"""Build any area on demand (pivot: "it must work anywhere").

POST /zones/rebuild {name, bbox, display_name?, anchors?}  -> builds the footpath graph for that
bbox from OSM into its own SQLite file (data/processed/zone_<name>.sqlite) in a background
thread, writes data/processed/active_zone.json, and switches the running API to it. No seed is
applied: a new area starts honestly with every edge `unknown`. POST again with a previously
built name to switch back instantly (the file is reused).
GET /zones/status reports progress; GET /zones lists built zones.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import Session

from api.db import get_engine, reset_db
from common import config
from common.paths import PROCESSED_DIR

log = logging.getLogger("samaan.zones")
router = APIRouter(tags=["zones"])
_state: dict[str, Any] = {"building": False, "name": None, "stage": None, "started_at": None, "error": None, "last": None,
                          "generation": 0}  # generation bumps on reset so a late build never switches the app
_lock = threading.Lock()
MAX_AREA_DEG2 = 0.03   # ~ 5 x 6 km at Indian latitudes; the OSM API caps at 0.25 and 50k nodes


class Bbox(BaseModel):
    south: float
    west: float
    north: float
    east: float


class AnchorIn(BaseModel):
    id: str
    kind: str = "metro"
    name_en: str
    name_hi: str | None = None
    lat: float
    lon: float


class RebuildIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=40)
    bbox: Bbox
    display_name_en: str | None = None
    display_name_hi: str | None = None
    anchors: list[AnchorIn] = Field(default_factory=list)
    force: bool = False  # rebuild even if the zone file exists


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", name.strip().lower()).strip("-") or "zone"


def zone_db_path(slug: str) -> Path:
    return PROCESSED_DIR / f"zone_{slug}.sqlite"


def _write_active(slug: str, cfg: dict[str, Any]) -> None:
    config.active_zone_file().write_text(json.dumps({**cfg, "slug": slug, "switched_at": datetime.now(UTC).isoformat()},
                                                    ensure_ascii=False, indent=2), encoding="utf-8")
    config.clear_cache()


def _switch_app(request_app: Any, db_path: Path) -> None:
    from api.services.routing import build_context
    from pipeline.graph.osm import load_nx_from_db

    os.environ["SAMAAN_DB"] = str(db_path)
    engine = get_engine(db_path)
    with Session(engine) as session:
        request_app.state.graph = load_nx_from_db(session)
        request_app.state.routing = build_context(session)


def _zone_cfg(body: RebuildIn, slug: str) -> dict[str, Any]:
    b = body.bbox
    anchors = [{"id": a.id, "kind": a.kind, "name": {"en": a.name_en, "hi": a.name_hi or a.name_en}, "lat": a.lat, "lon": a.lon,
                "source": "POST /zones/rebuild", "verified": False} for a in body.anchors]
    return {"name": slug,
            "display_name": {"en": body.display_name_en or body.name, "hi": body.display_name_hi or body.display_name_en or body.name},
            "bbox": {"south": b.south, "west": b.west, "north": b.north, "east": b.east},
            "center": {"lat": (b.south + b.north) / 2, "lon": (b.west + b.east) / 2},
            "anchors": anchors, "raw_cache": f"data/raw/zone_{slug}.osm",
            "demo": {"riya": {"synthetic": True, "origin_anchor": anchors[0]["id"] if anchors else None,
                              "target_network_distance_m": 800, "target_tolerance_m": 100,
                              "destination_label": {"en": "Demo destination", "hi": "डेमो गंतव्य"}, "barriers": []}}}


def _build(app: Any, body: RebuildIn, slug: str) -> None:
    from pipeline.graph.osm import build_zone_graph
    from pipeline.graph.validate import validate

    t0 = time.time()
    generation = _state["generation"]
    try:
        cfg = _zone_cfg(body, slug)
        full = {**config.load("zone"), **cfg}
        full["osm"] = {**config.load("zone")["osm"], "raw_cache": cfg["raw_cache"]}
        path = zone_db_path(slug)
        _state.update(stage="downloading OSM + synthesising footpaths")
        engine = reset_db(path)
        with Session(engine) as session:
            build_zone_graph(full, session, force_download=body.force, synthesis_cfg=None)
            _state.update(stage="validating")
            report = validate(session)
        if _state["generation"] != generation:
            log.info("zone %s built but a reset happened meanwhile; not switching", slug)
            _state.update(stage=None)
            return
        _write_active(slug, cfg)
        _switch_app(app, path)
        _state.update(last={"name": slug, "seconds": round(time.time() - t0, 1), "edges": report["edges"], "nodes": report["nodes"],
                            "components": report["components"], "length_km": report["total_length_km"], "built_at": datetime.now(UTC).isoformat()})
        log.info("zone %s built in %.1fs: %s edges", slug, time.time() - t0, report["edges"])
    except Exception as exc:
        log.exception("zone build failed")
        _state.update(error=str(exc)[:300])
    finally:
        _state.update(building=False, stage=None)


@router.post("/zones/rebuild", status_code=202)
def rebuild(body: RebuildIn, request: Request) -> dict[str, Any]:
    b = body.bbox
    if not (b.south < b.north and b.west < b.east):
        raise HTTPException(422, "bbox must have south < north and west < east")
    area = (b.north - b.south) * (b.east - b.west)
    if area > MAX_AREA_DEG2:
        raise HTTPException(422, f"bbox too large ({area:.4f} deg²); keep it under {MAX_AREA_DEG2} deg² (about 5 x 6 km)")
    slug = _slug(body.name)
    with _lock:
        if _state["building"]:
            raise HTTPException(409, f"already building {_state['name']}")
        existing = zone_db_path(slug)
        if existing.exists() and not body.force:
            _write_active(slug, _zone_cfg(body, slug))
            _switch_app(request.app, existing)
            return {"status": "switched", "name": slug, "db": str(existing), "built": False}
        _state.update(building=True, name=slug, stage="queued", started_at=datetime.now(UTC).isoformat(), error=None)
    threading.Thread(target=_build, args=(request.app, body, slug), daemon=True).start()
    return {"status": "building", "name": slug, "poll": "/zones/status"}


@router.get("/zones/status")
def status() -> dict[str, Any]:
    z = config.zone()
    return {**_state, "active": {"name": z["name"], "display_name": z["display_name"], "bbox": z["bbox"], "on_demand": z.get("on_demand", False)}}


@router.get("/zones")
def list_zones() -> dict[str, Any]:
    built = sorted(p.stem.replace("zone_", "", 1) for p in PROCESSED_DIR.glob("zone_*.sqlite"))
    return {"zones": built, "active": config.zone()["name"]}


@router.post("/zones/reset")
def reset(request: Request) -> dict[str, Any]:
    """Back to config/zone.yaml and the main database."""
    _state["generation"] += 1
    f = config.active_zone_file()
    if f.exists():
        f.unlink()
    config.clear_cache()
    os.environ.pop("SAMAAN_DB", None)
    from common.paths import db_path

    _switch_app(request.app, db_path())
    return {"status": "reset", "active": config.zone()["name"]}
