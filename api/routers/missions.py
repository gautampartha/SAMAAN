"""GET /missions, POST /missions/recompute (plan 6.9)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from shapely import wkt
from sqlmodel import Session, select

from api.db import get_session
from api.geojson import collection, feature
from api.models import Meta, Mission
from common import config
from pipeline.missions.compute import compute_missions, refresh_status

router = APIRouter(tags=["missions"])


@router.get("/missions")
def missions(limit: int = 10, session: Session = Depends(get_session)) -> dict[str, Any]:
    refresh_status(session)
    meta = {m.key: m.value for m in session.exec(select(Meta)).all()}
    rows = session.exec(select(Mission).order_by(Mission.rank).limit(limit)).all()  # type: ignore[arg-type]
    feats = []
    for m in rows:
        c = wkt.loads(m.geom_wkt).centroid
        feats.append(feature(m.geom_wkt, {
            "id": m.id, "rank": m.rank, "priority": m.priority, "n_routes": m.n_routes, "length_m": m.length_m,
            "status": m.status, "edge_ids": m.edge_ids, "name_en": m.name_en or "Unnamed footpath", "name_hi": m.name_hi or m.name_en or "अनाम फुटपाथ",
            "centroid": [c.x, c.y], "computed_at": m.computed_at.isoformat() if m.computed_at else None,
            "synthetic": meta.get("synthetic") == "true",
        }, fid=m.id))
    z = config.zone()
    return collection(feats, {"osm": z["osm"]["attribution"]}, meta.get("synthetic") == "true")


@router.post("/missions/recompute")
def recompute(session: Session = Depends(get_session), n_pairs: int | None = None) -> dict[str, Any]:
    return compute_missions(session, n_pairs=n_pairs)
