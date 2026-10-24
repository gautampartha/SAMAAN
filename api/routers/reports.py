"""Users, reports, votes (plan 6.8)."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, func, select

from api.db import get_session
from api.models import Report, User, Vote
from api.services import reports as svc

router = APIRouter(tags=["reports"])


class UserIn(BaseModel):
    display_name: str
    profile: str = "walker"
    language: str = "en"
    team: bool = False  # demo crew: starts trusted (config reports.trust.team_initial)


class VoteIn(BaseModel):
    user_id: int
    value: str


def _user_out(session: Session, u: User) -> dict[str, Any]:
    return {"id": u.id, "display_name": u.display_name, "trust_score": u.trust_score, "profile": u.profile, "language": u.language,
            "n_reports": session.exec(select(func.count(Report.id)).where(Report.user_id == u.id)).one(),
            "n_votes": session.exec(select(func.count(Vote.id)).where(Vote.user_id == u.id)).one()}


def _raise(exc: svc.ReportError) -> None:
    raise HTTPException(exc.status, exc.code)


@router.post("/users", status_code=201)
def create_user(body: UserIn, session: Session = Depends(get_session)) -> dict[str, Any]:
    try:
        return _user_out(session, svc.create_user(session, body.display_name, body.profile, body.language, body.team))
    except svc.ReportError as exc:
        _raise(exc)


@router.get("/users/{user_id}")
def get_user(user_id: int, session: Session = Depends(get_session)) -> dict[str, Any]:
    u = session.get(User, user_id)
    if u is None:
        raise HTTPException(404, "unknown_user")
    return _user_out(session, u)


def _refresh(request: Request, session: Session) -> None:
    from api.services.routing import build_context
    from pipeline.graph.osm import load_nx_from_db

    request.app.state.graph = load_nx_from_db(session)
    request.app.state.routing = build_context(session)


@router.post("/reports", status_code=201)
async def create_report(
    request: Request,
    user_id: Annotated[int, Form()],
    class_id: Annotated[str, Form()],
    severity: Annotated[int, Form()],
    lat: Annotated[float, Form()],
    lon: Annotated[float, Form()],
    photo: Annotated[UploadFile | None, File()] = None,
    note: Annotated[str | None, Form()] = None,
    heading_deg: Annotated[float | None, Form()] = None,
    pitch_deg: Annotated[float | None, Form()] = None,
    hfov_deg: Annotated[float | None, Form()] = None,
    captured_at: Annotated[str | None, Form()] = None,
    device_lat: Annotated[float | None, Form()] = None,
    device_lon: Annotated[float | None, Form()] = None,
    kind: Annotated[str, Form()] = "barrier",
    target_barrier_id: Annotated[int | None, Form()] = None,
    width: Annotated[int | None, Form()] = None,
    height: Annotated[int | None, Form()] = None,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    data = await photo.read() if photo is not None else None
    if data is not None and not data:
        data = None
    if data and not (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[:4] == b"RIFF"):
        raise HTTPException(415, "photo must be JPEG, PNG or WebP")
    cap = None
    if captured_at:
        try:
            cap = datetime.fromisoformat(captured_at)
            cap = cap if cap.tzinfo else cap.replace(tzinfo=UTC)
        except ValueError as exc:
            raise HTTPException(422, "captured_at is not ISO 8601") from exc
    try:
        r = svc.create_report(session, user_id=user_id, class_id=class_id, severity=severity, lat=lat, lon=lon, photo=data,
                              kind=kind, target_barrier_id=target_barrier_id, note=note, heading_deg=heading_deg, pitch_deg=pitch_deg,
                              hfov_deg=hfov_deg, captured_at=cap, device_lat=device_lat, device_lon=device_lon, image_w=width, image_h=height)
    except svc.ReportError as exc:
        _raise(exc)
    return svc.report_item(session, r, viewer_id=user_id)


@router.get("/reports")
def list_reports(session: Session = Depends(get_session), status: str | None = "pending", near_lat: float | None = None,
                 near_lon: float | None = None, radius_m: float | None = None, user_id: int | None = None,
                 limit: int = 20) -> dict[str, Any]:
    near = (near_lat, near_lon) if near_lat is not None and near_lon is not None else None
    radius = float(radius_m if radius_m is not None else svc.rcfg()["queue_radius_m"])
    items = svc.list_reports(session, status or None, near, radius, user_id, min(limit, 100), user_id)
    return {"count": len(items), "results": items}


@router.get("/reports/{report_id}")
def get_report(report_id: int, user_id: int | None = None, session: Session = Depends(get_session)) -> dict[str, Any]:
    r = session.get(Report, report_id)
    if r is None:
        raise HTTPException(404, "unknown_report")
    return svc.report_item(session, r, viewer_id=user_id)


@router.post("/reports/{report_id}/votes")
def vote(report_id: int, body: VoteIn, request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    try:
        result = svc.cast_vote(session, report_id, body.user_id, body.value)
    except svc.ReportError as exc:
        _raise(exc)
    if result["resolved"]:
        _refresh(request, session)
    return result
