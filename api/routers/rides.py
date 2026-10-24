"""Rides (plan 6.10): create, upload samples in batches, end + process, replay a demo ride,
and the wheels layer."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from shapely import wkt
from sqlmodel import Session, select

from api.db import get_session
from api.geojson import collection, feature, point_feature
from api.models import Barrier, EdgeRideStat, FootpathEdge, Meta, Ride, RideSample, User
from common import config
from pipeline.ride.process import demo_ride_edges, process_ride, synthetic_ride_samples
from pipeline.state.recompute import recompute_states

router = APIRouter(tags=["rides"])


class RideIn(BaseModel):
    user_id: int
    started_at: str | None = None
    device: str | None = None
    sample_rate_hz: float | None = None


class SampleIn(BaseModel):
    t: float
    ax: float | None = None
    ay: float | None = None
    az: float | None = None
    lat: float | None = None
    lon: float | None = None
    gps_accuracy_m: float | None = None
    speed_m_s: float | None = None


class SamplesIn(BaseModel):
    samples: list[SampleIn] = Field(default_factory=list)


class EndIn(BaseModel):
    ended_at: str | None = None


class ReplayIn(BaseModel):
    user_id: int


def _dt(value: str | None) -> datetime:
    if not value:
        return datetime.now(UTC)
    try:
        d = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(422, "timestamps must be ISO 8601") from exc
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def _summary(ride: Ride) -> dict[str, Any]:
    if ride.summary:
        return {**ride.summary, "status": ride.status}
    return {"id": ride.id, "status": ride.status, "user_id": ride.user_id, "started_at": ride.started_at.isoformat() if ride.started_at else None,
            "n_samples": ride.n_samples, "synthetic": ride.synthetic}


def _refresh(request: Request, session: Session) -> None:
    from api.services.routing import build_context
    from pipeline.graph.osm import load_nx_from_db

    request.app.state.graph = load_nx_from_db(session)
    request.app.state.routing = build_context(session)


@router.post("/rides", status_code=201)
def create_ride(body: RideIn, session: Session = Depends(get_session)) -> dict[str, Any]:
    if session.get(User, body.user_id) is None:
        raise HTTPException(404, "unknown_user")
    ride = Ride(user_id=body.user_id, started_at=_dt(body.started_at), device=body.device, sample_rate_hz=body.sample_rate_hz,
                status="active", synthetic=False)
    session.add(ride)
    session.commit()
    session.refresh(ride)
    return _summary(ride)


@router.post("/rides/{ride_id}/samples")
def add_samples(ride_id: int, body: SamplesIn, session: Session = Depends(get_session)) -> dict[str, int]:
    ride = session.get(Ride, ride_id)
    if ride is None:
        raise HTTPException(404, "unknown_ride")
    if ride.status != "active":
        raise HTTPException(400, "ride_ended")
    rows = [RideSample(ride_id=ride_id, **s.model_dump()) for s in body.samples if s.t >= 0]
    session.add_all(rows)
    ride.n_samples += len(rows)
    session.add(ride)
    session.commit()
    return {"accepted": len(rows), "total": ride.n_samples}


@router.post("/rides/{ride_id}/end")
def end_ride(ride_id: int, body: EndIn, request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    ride = session.get(Ride, ride_id)
    if ride is None:
        raise HTTPException(404, "unknown_ride")
    if ride.status == "processed":
        return _summary(ride)
    ride.ended_at = _dt(body.ended_at)
    ride.status = "ended"
    session.add(ride)
    session.commit()
    summary = process_ride(session, ride)
    recompute_states(session)
    _refresh(request, session)
    return summary


@router.get("/rides/{ride_id}")
def get_ride(ride_id: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    ride = session.get(Ride, ride_id)
    if ride is None:
        raise HTTPException(404, "unknown_ride")
    return _summary(ride)


@router.post("/rides/replay-demo")
def replay_demo(body: ReplayIn, request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Generate and process a SYNTHETIC ride along Riya's route (flagged synthetic everywhere)."""
    if session.get(User, body.user_id) is None:
        raise HTTPException(404, "unknown_user")
    edges = demo_ride_edges(session)
    if not edges:
        raise HTTPException(404, "no demo route in this database")
    cfg = config.pipeline()["ride"]
    samples = synthetic_ride_samples([wkt.loads(e.geom_m_wkt) for e in edges], cfg, jolt_at_fraction=0.5)
    ride = Ride(user_id=body.user_id, started_at=datetime.now(UTC), device="synthetic demo replay", sample_rate_hz=float(cfg["accel_hz"]),
                status="ended", synthetic=True)
    session.add(ride)
    session.commit()
    session.refresh(ride)
    session.add_all([RideSample(ride_id=ride.id, t=s.t, ax=s.ax, ay=s.ay, az=s.az, lat=s.lat, lon=s.lon, gps_accuracy_m=s.gps_accuracy_m,
                                speed_m_s=s.speed_m_s) for s in samples])
    session.commit()
    summary = process_ride(session, ride)
    recompute_states(session)
    _refresh(request, session)
    return summary


@router.get("/layers/wheels")
def wheels_layer(session: Session = Depends(get_session)) -> dict[str, Any]:
    names = config.class_names()
    meta = {m.key: m.value for m in session.exec(select(Meta)).all()}
    edges = {e.id: e for e in session.exec(select(FootpathEdge)).all()}
    feats = []
    stats = session.exec(select(EdgeRideStat)).all()
    for st in stats:
        e = edges.get(st.edge_id)
        if e is None:
            continue
        feats.append(feature(e.geom_wkt, {
            "edge_id": st.edge_id, "roughness_index": st.roughness_index, "n_traversals": st.n_traversals, "n_windows": st.n_windows,
            "verified_by_wheels": st.verified_by_wheels, "last_traversed_at": st.last_traversed_at.isoformat() if st.last_traversed_at else None,
            "n_jolts": len(st.jolt_events or []), "synthetic": st.synthetic,
        }, fid=f"edge:{st.edge_id}"))
    jolts = [b for b in session.exec(select(Barrier).where(Barrier.status == "suspected")).all()]
    for b in jolts:
        peak = None
        for src in b.sources or []:
            if src.startswith("ride:"):
                peak = next((ev["peak"] for st in stats for ev in (st.jolt_events or []) if ev.get("barrier_id") == b.id), None)
                break
        feats.append(point_feature(b.lon, b.lat, {
            "kind": "jolt", "barrier_id": b.id, "class": b.class_id, "name_en": names.get(b.class_id, {}).get("en", b.class_id),
            "name_hi": names.get(b.class_id, {}).get("hi", b.class_id), "peak_m_s2": peak, "status": b.status, "edge_id": b.edge_id,
            "note": b.note, "synthetic": b.synthetic,
        }, fid=f"jolt:{b.id}"))
    z = config.zone()
    return collection(feats, {"osm": z["osm"]["attribution"]}, any(f["properties"]["synthetic"] for f in feats) or meta.get("synthetic") == "true")
