"""GET /reach, GET /reach/anchors (plan 6.7)."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel import Session, select

from api.db import get_session
from api.models import Anchor, Meta
from api.routers.route import get_ctx
from api.services.reach import reach_gap
from common import config

router = APIRouter(tags=["reach"])


@router.get("/reach/anchors")
def anchors(session: Session = Depends(get_session)) -> dict[str, Any]:
    rows = session.exec(select(Anchor)).all()
    order = {"metro": 0, "bus_stop": 1, "hospital": 2, "school": 3}
    rows.sort(key=lambda a: (order.get(a.kind, 9), a.name_en))
    return {"anchors": [{"id": a.id, "kind": a.kind, "name_en": a.name_en, "name_hi": a.name_hi, "lat": a.lat, "lon": a.lon,
                         "verified": a.verified, "node_id": a.node_id} for a in rows if a.node_id is not None]}


@router.get("/reach")
def reach(request: Request, anchor: str = Query(...), profile: str | None = None, cutoff_min: float | None = None,
          risk: str | None = None, fixed: str | None = Query(None, description="comma-separated barrier ids to simulate as fixed"),
          depart: str | None = None, session: Session = Depends(get_session)) -> dict[str, Any]:
    ctx = get_ctx(request)
    rcfg = config.pipeline()["reach"]
    profile = profile or rcfg["default_profile"]
    risk = risk or rcfg["default_risk"]
    cutoff = float(cutoff_min if cutoff_min is not None else rcfg["default_cutoff_min"])
    if profile not in ctx.profiles_cfg["profiles"] or profile == "walker":
        raise HTTPException(422, "profile must be wheelchair_manual, elderly_walking_aid or pram")
    if risk not in ("strict", "balanced", "relaxed"):
        raise HTTPException(422, "risk must be strict, balanced or relaxed")
    if not 1 <= cutoff <= 60:
        raise HTTPException(422, "cutoff_min must be between 1 and 60")
    a = session.get(Anchor, anchor)
    if a is None or a.node_id is None or a.node_id not in ctx.node_xy:
        raise HTTPException(404, f"unknown anchor {anchor!r}")
    fixed_ids: set[int] = set()
    if fixed:
        try:
            fixed_ids = {int(x) for x in fixed.split(",") if x.strip()}
        except ValueError as exc:
            raise HTTPException(422, "fixed must be comma-separated integers") from exc
    hour = datetime.now().hour
    if depart:
        try:
            hour = datetime.fromisoformat(depart).hour
        except ValueError as exc:
            raise HTTPException(422, "depart must be ISO 8601") from exc
    out = reach_gap(ctx, a.node_id, profile, cutoff, risk, hour, fixed_ids or None)
    meta = {m.key: m.value for m in session.exec(select(Meta)).all()}
    out["anchor"] = {"id": a.id, "kind": a.kind, "name_en": a.name_en, "name_hi": a.name_hi, "lat": a.lat, "lon": a.lon}
    out["synthetic_overlay"] = meta.get("synthetic") == "true"
    return out
