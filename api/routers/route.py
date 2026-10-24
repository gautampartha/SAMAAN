"""GET /route: three route modes (plan 6.6) for the comparison view."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel import Session, select

from api.db import get_session
from api.models import DemoRoute, FootpathNode, Meta
from api.services.routing import RoutingContext, build_context, nearest_node, route_all_modes
from common import config

router = APIRouter(tags=["routing"])


def get_ctx(request: Request) -> RoutingContext:
    ctx = getattr(request.app.state, "routing", None)
    if ctx is None:
        raise HTTPException(503, "routing context not loaded")
    return ctx


def refresh_context(request: Request, session: Session) -> RoutingContext:
    ctx = build_context(session)
    request.app.state.routing = ctx
    return ctx


@router.get("/route")
def route(
    request: Request,
    from_lat: float | None = Query(None), from_lon: float | None = Query(None),
    to_lat: float | None = Query(None), to_lon: float | None = Query(None),
    demo: str | None = Query(None, description="use a stored demo trip, e.g. riya"),
    profile: str | None = Query(None), risk: str | None = Query(None),
    depart: str | None = Query(None, description="ISO datetime; only the hour matters"),
    modes: str = Query("two", description="two = standard + samaan (UI); all = also naive_accessible (eval)"),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    ctx = get_ctx(request)
    rcfg = config.pipeline().get("routing", {})
    profile = profile or rcfg.get("default_profile", "wheelchair_manual")
    risk = risk or rcfg.get("default_risk", "balanced")
    if profile not in ctx.profiles_cfg["profiles"]:
        raise HTTPException(422, f"unknown profile {profile}; one of {sorted(ctx.profiles_cfg['profiles'])}")
    if risk not in ctx.profiles_cfg["unknown_multiplier"] or risk == "source":
        raise HTTPException(422, "risk must be strict, balanced or relaxed")
    depart_dt = None
    if depart:
        try:
            depart_dt = datetime.fromisoformat(depart)
        except ValueError as exc:
            raise HTTPException(422, "depart must be ISO 8601") from exc
    snap_info: dict[str, Any] = {}
    if demo:
        d = session.get(DemoRoute, demo)
        if d is None:
            raise HTTPException(404, f"no demo trip {demo!r}")
        origin, dest = d.origin_node_id, d.destination_node_id
        o, t = session.get(FootpathNode, origin), session.get(FootpathNode, dest)
        snap_info = {"demo": demo, "label_en": d.label_en, "label_hi": d.label_hi, "origin": {"lat": o.lat, "lon": o.lon},
                     "destination": {"lat": t.lat, "lon": t.lon}, "synthetic": d.synthetic}
    else:
        if None in (from_lat, from_lon, to_lat, to_lon):
            raise HTTPException(422, "give from_lat, from_lon, to_lat, to_lon or demo=<id>")
        max_m = float(rcfg.get("snap_origin_max_m", 150))
        origin, d_o = nearest_node(ctx, from_lon, from_lat, max_m)
        dest, d_d = nearest_node(ctx, to_lon, to_lat, max_m)
        if origin is None or dest is None:
            raise HTTPException(404, f"origin or destination is more than {max_m:.0f} m from the footpath network")
        snap_info = {"origin": {"lat": from_lat, "lon": from_lon, "snap_distance_m": round(d_o, 1)},
                     "destination": {"lat": to_lat, "lon": to_lon, "snap_distance_m": round(d_d, 1)}}
    result = route_all_modes(ctx, origin, dest, profile, risk, depart_dt, modes=modes)
    meta = {m.key: m.value for m in session.exec(select(Meta)).all()}
    result["synthetic_overlay"] = meta.get("synthetic") == "true"
    for r in result["routes"].values():
        if r:
            r["synthetic"] = bool(r["synthetic"] or result["synthetic_overlay"])
    result.update(snap_info)
    return result


@router.get("/profiles")
def profiles() -> dict[str, Any]:
    p = config.profiles()
    modes = p.get("profile_modes", {})
    out = []
    for pid, prof in p["profiles"].items():
        out.append({"id": pid, "name_en": prof["name"]["en"], "name_hi": prof["name"]["hi"],
                    "description_en": (prof.get("description") or {}).get("en", ""), "description_hi": (prof.get("description") or {}).get("hi", ""),
                    "mode": modes.get(pid, "move"), "speed_m_s": prof["speed_m_s"]["value"], "speed_source": prof["speed_m_s"]["source"]})
    return {"profiles": out}


@router.post("/route/reload")
def reload(request: Request, session: Session = Depends(get_session)) -> dict[str, int]:
    ctx = refresh_context(request, session)
    return {"nodes": ctx.graph.number_of_nodes(), "edges": ctx.graph.number_of_edges(),
            "edges_with_barriers": len(ctx.barriers_by_edge)}
