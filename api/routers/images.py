"""Own-photo upload, photo serving, images layer and coverage recompute (plan 6.2)."""
from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from api.db import get_session, session_scope
from api.geojson import collection, point_feature
from api.models import Image
from api.services.reports import stored_path
from common import config
from common.paths import ROOT
from pipeline.coverage.compute import compute_coverage
from pipeline.state.recompute import recompute_states

log = logging.getLogger("samaan.images")
router = APIRouter(tags=["images"])
OWN_DIR = ROOT / "data" / "raw" / "own"
MAX_PHOTO_BYTES = 15 * 1024 * 1024
_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _parse_dt(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    try:
        dt = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(422, f"captured_at is not ISO 8601: {value}") from exc
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def recompute_all(request: Request | None = None) -> dict[str, Any]:
    """Coverage + states, then refresh the in-memory routing graph. Used as a background task."""
    with session_scope() as session:
        from pipeline.state.expire import expire_temporary_barriers

        expired = expire_temporary_barriers(session)
        cov = compute_coverage(session)
        states = recompute_states(session)
        if request is not None:
            from api.services.routing import build_context
            from pipeline.graph.osm import load_nx_from_db

            request.app.state.graph = load_nx_from_db(session)
            request.app.state.routing = build_context(session)
    return {"coverage": cov, "states": states, "expired": expired}


@router.post("/images", status_code=201)
async def upload_image(
    request: Request,
    background: BackgroundTasks,
    photo: Annotated[UploadFile, File()],
    lat: Annotated[float, Form()],
    lon: Annotated[float, Form()],
    source: Annotated[str, Form()] = "own",
    gps_accuracy_m: Annotated[float | None, Form()] = None,
    heading_deg: Annotated[float | None, Form()] = None,
    pitch_deg: Annotated[float | None, Form()] = None,
    hfov_deg: Annotated[float | None, Form()] = None,
    captured_at: Annotated[str | None, Form()] = None,
    session_id: Annotated[str | None, Form()] = None,
    note: Annotated[str | None, Form()] = None,
    width: Annotated[int | None, Form()] = None,
    height: Annotated[int | None, Form()] = None,
    heading_source: Annotated[str | None, Form()] = None,
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    if source not in ("own", "report"):
        raise HTTPException(422, "source must be 'own' or 'report'")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(422, "lat/lon out of range")
    if heading_deg is not None:
        heading_deg = heading_deg % 360.0
    data = await photo.read()
    if not data:
        raise HTTPException(422, "empty photo")
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "photo larger than 15 MB")
    if not (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[:4] == b"RIFF"):
        raise HTTPException(415, "photo must be JPEG, PNG or WebP")
    cov_cfg = config.pipeline()["coverage"]
    img = Image(
        source=source, lat=lat, lon=lon, gps_accuracy_m=gps_accuracy_m, heading_deg=heading_deg,
        heading_source=heading_source or ("none" if heading_deg is None else "device"), pitch_deg=pitch_deg,
        hfov_deg=float(hfov_deg or cov_cfg["default_hfov_deg"]), captured_at=_parse_dt(captured_at),
        width=width, height=height, session_id=session_id, note=note,
        attribution="SAMAAN team photo (own capture)", synthetic=False,
    )
    db.add(img)
    db.commit()
    db.refresh(img)
    ext = ".png" if data[:8] == b"\x89PNG\r\n\x1a\n" else ".webp" if data[:4] == b"RIFF" else ".jpg"
    sess = _SAFE.sub("_", session_id or "nosession")[:40]
    dest = OWN_DIR / sess / f"{img.id}{ext}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    img.path = stored_path(dest)
    db.add(img)
    db.commit()
    background.add_task(recompute_all, request)
    return {"id": img.id, "path": img.path, "captured_at": img.captured_at.isoformat(), "heading_deg": img.heading_deg,
            "hfov_deg": img.hfov_deg, "session_id": img.session_id, "bytes": len(data)}


@router.get("/images/{image_id}/photo")
def photo_file(image_id: int, db: Session = Depends(get_session)) -> FileResponse:
    img = db.get(Image, image_id)
    if img is None or not img.path:
        raise HTTPException(404, "no photo stored for this image")
    path = (ROOT / img.path).resolve()  # an absolute img.path stays absolute
    from api.services import reports as _reports

    allowed = {ROOT.resolve(), Path(OWN_DIR).resolve(), Path(_reports.REPORT_DIR).resolve()}
    if not any(a == path.parent or a in path.parents for a in allowed) or not path.exists():
        raise HTTPException(404, "photo file missing")
    return FileResponse(path)


@router.get("/images/{image_id}")
def image_meta(image_id: int, db: Session = Depends(get_session)) -> dict[str, Any]:
    img = db.get(Image, image_id)
    if img is None:
        raise HTTPException(404, "unknown image")
    d = img.model_dump()
    d["captured_at"] = img.captured_at.isoformat() if img.captured_at else None
    d["has_photo"] = bool(img.path and (ROOT / img.path).exists())
    return d


@router.get("/layers/images")
def images_layer(db: Session = Depends(get_session), source: str | None = None, limit: int = 5000) -> dict[str, Any]:
    q = select(Image).order_by(Image.id.desc()).limit(limit)  # type: ignore[union-attr]
    if source:
        q = q.where(Image.source == source)
    rows = db.exec(q).all()
    feats = [point_feature(i.lon, i.lat, {
        "id": i.id, "source": i.source, "source_id": i.source_id, "heading_deg": i.heading_deg,
        "heading_source": i.heading_source, "pitch_deg": i.pitch_deg, "hfov_deg": i.hfov_deg,
        "gps_accuracy_m": i.gps_accuracy_m, "captured_at": i.captured_at.isoformat() if i.captured_at else None,
        "attribution": i.attribution, "session_id": i.session_id, "note": i.note, "camera_type": i.camera_type,
        "has_photo": bool(i.path and (ROOT / i.path).exists()), "synthetic": i.synthetic,
    }, fid=i.id) for i in rows]
    z = config.zone()
    return collection(feats, {"osm": z["osm"]["attribution"], "images": "see each feature's attribution"},
                      any(i.synthetic for i in rows))


@router.post("/coverage/recompute")
def coverage_recompute(request: Request) -> dict[str, Any]:
    return recompute_all(request)


def own_photo_dir() -> Path:
    return OWN_DIR
