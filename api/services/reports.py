"""Citizen reports (plan 6.8): pipeline, validation votes, trust, fixed flow.

store -> prescreen (detector, when weights exist) -> geolocate + side-aware snap (P4) ->
duplicate check -> pending. Votes: score = Σ(vote weight × voter trust); at/above the verify
threshold the report becomes a barrier (or closes one, for kind=fixed), states and the routing
context are recomputed right away; reporter and voter trust move with the outcome.
"""
from __future__ import annotations

import logging
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from shapely.geometry import Point
from sqlmodel import Session, select

from api.models import Barrier, FootpathEdge, Image, Report, RoadCentreline, User, Vote
from common import config
from common.crs import lonlat_to_xy
from common.paths import ROOT
from pipeline.geolocate.geolocate import Box, Camera, EdgeIndex, RoadIndex, snap_detection
from pipeline.state.recompute import recompute_states

log = logging.getLogger("samaan.reports")
REPORT_DIR = ROOT / "data" / "raw" / "reports"


class ReportError(Exception):
    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(message or code)
        self.status, self.code = status, code


def rcfg() -> dict[str, Any]:
    return config.pipeline()["reports"]


# ----------------------------------------------------------------------------- users


def create_user(session: Session, display_name: str, profile: str, language: str, team: bool = False) -> User:
    if profile not in config.profiles()["profiles"]:
        raise ReportError(422, "unknown_profile")
    t = rcfg()["trust"]
    u = User(display_name=display_name.strip()[:60] or "Anonymous", profile=profile, language=language if language in ("en", "hi") else "en",
             trust_score=float(t["team_initial"] if team else t["initial"]))
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _clamp_trust(v: float) -> float:
    t = rcfg()["trust"]
    return round(min(float(t["max"]), max(float(t["min"]), v)), 3)


# ----------------------------------------------------------------------------- prescreen


def prescreen_weights() -> Path | None:
    p = ROOT / rcfg()["prescreen"]["weights"]
    return p if p.exists() else None


def prescreen(photo_path: Path, class_id: str) -> tuple[float | None, list[float] | None]:
    """(max detector score for the reported class, its box) or (None, None) without weights."""
    weights = prescreen_weights()
    if weights is None:
        return None, None
    try:
        from ml.common import predict

        dets = predict(weights, [photo_path], float(rcfg()["prescreen"]["min_score"]), int(config.load("train")["infer"]["imgsz"]))
        same = [d for d in dets.get(photo_path, []) if d.cls == class_id]
        if not same:
            return 0.0, None
        best = max(same, key=lambda d: d.conf)
        return round(best.conf, 3), list(best.box)
    except Exception as exc:  # noqa: BLE001 - prescreen must never block a report
        log.warning("prescreen failed: %s", exc)
        return None, None


# ----------------------------------------------------------------------------- create


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    x1, y1 = lonlat_to_xy(lon1, lat1)
    x2, y2 = lonlat_to_xy(lon2, lat2)
    return math.hypot(x2 - x1, y2 - y1)


def create_report(session: Session, *, user_id: int, class_id: str, severity: int, lat: float, lon: float,
                  photo: bytes | None, kind: str = "barrier", target_barrier_id: int | None = None, note: str | None = None,
                  heading_deg: float | None = None, pitch_deg: float | None = None, hfov_deg: float | None = None,
                  captured_at: datetime | None = None, device_lat: float | None = None, device_lon: float | None = None,
                  image_w: int | None = None, image_h: int | None = None, now: datetime | None = None) -> Report:
    now = now or datetime.now(UTC)
    cfg = rcfg()
    user = session.get(User, user_id)
    if user is None:
        raise ReportError(404, "unknown_user")
    if class_id not in config.all_class_ids():
        raise ReportError(422, "unknown_class")
    if not 1 <= int(severity) <= 5:
        raise ReportError(422, "bad_severity")
    if kind not in ("barrier", "fixed"):
        raise ReportError(422, "bad_kind")
    target = None
    if kind == "fixed":
        target = session.get(Barrier, target_barrier_id) if target_barrier_id else None
        if target is None:
            raise ReportError(404, "unknown_target_barrier")
    recent = session.exec(select(Report).where(Report.user_id == user_id, Report.created_at >= now - timedelta(hours=1))).all()
    if len(recent) >= int(cfg["rate_limit_per_hour"]):
        raise ReportError(429, "rate_limit")
    if device_lat is not None and device_lon is not None and _haversine_m(lat, lon, device_lat, device_lon) > float(cfg["max_photo_gps_offset_m"]):
        raise ReportError(422, "gps_offset")

    img = None
    if photo:
        img = Image(source="report", lat=lat, lon=lon, heading_deg=heading_deg, pitch_deg=pitch_deg,
                    hfov_deg=float(hfov_deg or cfg["default_hfov_deg"]), captured_at=captured_at or now, width=image_w, height=image_h,
                    attribution=f"SAMAAN citizen report by user {user_id}", heading_source="device" if heading_deg is not None else "none",
                    synthetic=False)
        session.add(img)
        session.flush()
        dest = REPORT_DIR / f"{img.id}.jpg"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(photo)
        img.path = str(dest.relative_to(ROOT))

    report = Report(user_id=user_id, photo_image_id=img.id if img else None, kind=kind, target_barrier_id=target.id if target else None,
                    class_id=class_id, severity=int(severity), note=(note or None), lat=lat, lon=lon, heading_deg=heading_deg,
                    device_lat=device_lat, device_lon=device_lon, created_at=now, synthetic=False)
    if img and img.path:
        report.model_prescreen_score, report.prescreen_box = prescreen(ROOT / img.path, class_id)

    # geolocate + snap (plan 6.4) - the photo centre is the pointing direction; with a prescreen
    # box we use it, otherwise a centred box low in the frame (ground-plane fallback distance)
    roads = RoadIndex(session.exec(select(RoadCentreline)).all())
    edges = EdgeIndex(session.exec(select(FootpathEdge)).all())
    w, h = image_w or 1000, image_h or 1000
    x, y = lonlat_to_xy(lon, lat)
    cam = Camera(x, y, heading_deg, pitch_deg, float(hfov_deg or cfg["default_hfov_deg"]), w, h, None, None)
    box = Box(*report.prescreen_box) if report.prescreen_box else Box(w * 0.4, h * 0.4, w * 0.6, h * 0.5)
    if heading_deg is None:
        # no heading: the barrier is where the reporter stands; snap the camera position itself
        pipeline_cfg = config.pipeline()
        cands = edges.candidates(Point(x, y), float(pipeline_cfg["snapping"]["max_snap_distance_m"]))
        if cands:
            e, g, _d = cands[0]
            report.edge_id, report.side, report.position_along_edge_m, report.snap_confidence = e.id, e.side, float(g.project(Point(x, y))), 0.5
    else:
        _, snapped = snap_detection(cam, box, roads, edges, config.pipeline(), float(config.pipeline()["coverage"]["camera_height_m"]))
        report.edge_id, report.side = snapped.edge_id, snapped.side
        report.position_along_edge_m, report.snap_confidence = snapped.position_along_edge_m, snapped.confidence

    if kind == "barrier":
        dup = find_duplicate(session, class_id, lat, lon, float(cfg["duplicate_distance_m"]))
        report.duplicate_of_barrier_id = dup.id if dup else None
    session.add(report)
    session.flush()
    # Phase 2 "update within a minute": a trusted reporter with a photo needs no second voter.
    auto = float(cfg["trust"].get("auto_verify_trust", 1.01))
    if img is not None and user.trust_score >= auto:
        report.score = round(user.trust_score, 3)
        resolve(session, report, "verified", [], {user.id: user}, now)
        report.sources_note = "auto-verified: trusted reporter with photo"
    session.add(report)
    session.commit()
    session.refresh(report)
    return report


def find_duplicate(session: Session, class_id: str, lat: float, lon: float, radius_m: float) -> Barrier | None:
    x, y = lonlat_to_xy(lon, lat)
    best, best_d = None, radius_m
    for b in session.exec(select(Barrier).where(Barrier.class_id == class_id, Barrier.status == "active")).all():
        bx, by = lonlat_to_xy(b.lon, b.lat)
        d = math.hypot(bx - x, by - y)
        if d <= best_d:
            best, best_d = b, d
    return best


# ----------------------------------------------------------------------------- votes + resolution


def vote_summary(session: Session, report_id: int) -> dict[str, int]:
    out = {"agree": 0, "disagree": 0, "unsure": 0}
    for v in session.exec(select(Vote).where(Vote.report_id == report_id)).all():
        out[v.value] = out.get(v.value, 0) + 1
    return out


def cast_vote(session: Session, report_id: int, user_id: int, value: str, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    cfg = rcfg()
    report = session.get(Report, report_id)
    if report is None:
        raise ReportError(404, "unknown_report")
    voter = session.get(User, user_id)
    if voter is None:
        raise ReportError(404, "unknown_user")
    if report.user_id == user_id:
        raise ReportError(409, "own_report")
    if report.status != "pending":
        raise ReportError(400, "already_resolved")
    if value not in cfg["votes"]["weights"]:
        raise ReportError(422, "bad_vote")
    existing = session.exec(select(Vote).where(Vote.report_id == report_id, Vote.user_id == user_id)).first()
    if existing:
        existing.value = value
        existing.created_at = now
        session.add(existing)
    else:
        session.add(Vote(report_id=report_id, user_id=user_id, value=value, created_at=now))
    session.flush()
    votes = session.exec(select(Vote).where(Vote.report_id == report_id)).all()
    users = {u.id: u for u in session.exec(select(User)).all()}
    score = sum(float(cfg["votes"]["weights"][v.value]) * users[v.user_id].trust_score for v in votes if v.user_id in users)
    report.score, report.n_votes = round(score, 3), len(votes)
    resolved = False
    if score >= float(cfg["votes"]["verify_threshold"]):
        resolve(session, report, "verified", votes, users, now)
        resolved = True
    elif score <= float(cfg["votes"]["reject_threshold"]):
        resolve(session, report, "rejected", votes, users, now)
        resolved = True
    session.add(report)
    session.commit()
    session.refresh(voter)
    return {"report_id": report.id, "status": report.status, "score": report.score, "n_votes": report.n_votes,
            "votes": vote_summary(session, report.id), "resolved": resolved, "barrier_id": report.barrier_id,
            "voter_trust_score": voter.trust_score}


def resolve(session: Session, report: Report, outcome: str, votes: list[Vote], users: dict[int, User], now: datetime) -> None:
    cfg = rcfg()
    t = cfg["trust"]
    report.status = outcome
    report.resolved_at = now
    reporter = users.get(report.user_id) or session.get(User, report.user_id)
    if reporter:
        reporter.trust_score = _clamp_trust(reporter.trust_score + (float(t["reporter_verified_gain"]) if outcome == "verified" else -float(t["reporter_rejected_loss"])))
        session.add(reporter)
    consensus = "agree" if outcome == "verified" else "disagree"
    for v in votes:
        u = users.get(v.user_id)
        if u is None or v.value == "unsure":
            continue
        u.trust_score = _clamp_trust(u.trust_score + (float(t["voter_consensus_gain"]) if v.value == consensus else -float(t["voter_dissent_loss"])))
        session.add(u)
    if outcome == "verified":
        if report.kind == "fixed":
            target = session.get(Barrier, report.target_barrier_id)
            if target is not None:
                target.status, target.fixed_at = "fixed", now
                target.sources = list(target.sources or []) + [f"report_fixed:{report.id}"]
                session.add(target)
                report.barrier_id = target.id
        else:
            report.barrier_id = upsert_barrier_from_report(session, report, now).id
    session.flush()
    recompute_states(session, now=now)


def upsert_barrier_from_report(session: Session, report: Report, now: datetime) -> Barrier:
    cfg = rcfg()
    conf = float(cfg["base_confidence"])
    if report.model_prescreen_score is not None:
        conf += float(cfg["prescreen"]["match_bonus"]) * report.model_prescreen_score if report.model_prescreen_score >= float(cfg["prescreen"]["min_score"]) else -float(cfg["prescreen"]["mismatch_penalty"])
    conf = min(0.95, max(0.1, conf))
    sources = [f"report:{report.id}"] + ([f"image:{report.photo_image_id}"] if report.photo_image_id else [])
    target = session.get(Barrier, report.duplicate_of_barrier_id) if report.duplicate_of_barrier_id else None
    if target is not None and target.status == "active":
        sev = sorted([target.severity, report.severity])
        target.severity = round(sum(sev) / len(sev))
        target.confidence = round(min(0.98, target.confidence + 0.1), 3)
        target.sources = list(target.sources or []) + sources
        target.last_seen_at = now
        session.add(target)
        return target
    edge = session.get(FootpathEdge, report.edge_id) if report.edge_id else None
    if edge is None:
        # fall back to the nearest edge of any kind so the barrier can affect routing
        edges = EdgeIndex(session.exec(select(FootpathEdge)).all())
        x, y = lonlat_to_xy(report.lon, report.lat)
        cands = edges.candidates(Point(x, y), 50.0)
        if cands:
            edge = cands[0][0]
            report.edge_id, report.side = edge.id, edge.side
            report.position_along_edge_m = float(cands[0][1].project(Point(x, y)))
    temporary = report.class_id in config.temporary_classes()
    b = Barrier(class_id=report.class_id, severity=report.severity, tags=[], edge_id=edge.id if edge else 0,
                side=(edge.side if edge else "none"), position_along_edge_m=float(report.position_along_edge_m or 0.0),
                lat=report.lat, lon=report.lon, permanent=not temporary,
                time_profile=([0.5] * 24 if temporary else None), status="active", confidence=round(conf, 3),
                sources=sources, note=report.note, created_at=now, last_seen_at=now, synthetic=False)
    session.add(b)
    session.flush()
    return b


# ----------------------------------------------------------------------------- queue / serialisation


def report_item(session: Session, r: Report, viewer_id: int | None = None, near: tuple[float, float] | None = None) -> dict[str, Any]:
    names = config.class_names()
    img = session.get(Image, r.photo_image_id) if r.photo_image_id else None
    my_vote = None
    if viewer_id is not None:
        v = session.exec(select(Vote).where(Vote.report_id == r.id, Vote.user_id == viewer_id)).first()
        my_vote = v.value if v else None
    target = session.get(Barrier, r.target_barrier_id) if r.target_barrier_id else None
    return {
        "id": r.id, "kind": r.kind, "status": r.status, "class_id": r.class_id,
        "name_en": names.get(r.class_id, {}).get("en", r.class_id), "name_hi": names.get(r.class_id, {}).get("hi", r.class_id),
        "severity": r.severity, "note": r.note, "lat": r.lat, "lon": r.lon, "heading_deg": r.heading_deg,
        "edge_id": r.edge_id, "side": r.side, "snap_confidence": r.snap_confidence,
        "model_prescreen_score": r.model_prescreen_score, "duplicate_of_barrier_id": r.duplicate_of_barrier_id,
        "barrier_id": r.barrier_id, "target_barrier_id": r.target_barrier_id,
        "photo_url": f"/images/{img.id}/photo" if img and img.path else None,
        "score": r.score, "n_votes": r.n_votes, "votes": vote_summary(session, r.id), "my_vote": my_vote,
        "distance_m": round(_haversine_m(r.lat, r.lon, near[0], near[1]), 1) if near else None,
        "user_id": r.user_id, "created_at": r.created_at.isoformat() if r.created_at else None,
        "resolved_at": r.resolved_at.isoformat() if r.resolved_at else None, "synthetic": r.synthetic,
        "target_barrier": ({"id": target.id, "class_id": target.class_id, "name_en": names.get(target.class_id, {}).get("en", target.class_id),
                            "name_hi": names.get(target.class_id, {}).get("hi", target.class_id), "severity": target.severity, "status": target.status}
                           if target else None),
    }


def list_reports(session: Session, status: str | None, near: tuple[float, float] | None, radius_m: float,
                 exclude_user: int | None, limit: int, viewer_id: int | None) -> list[dict[str, Any]]:
    q = select(Report)
    if status:
        q = q.where(Report.status == status)
    rows = session.exec(q).all()
    if exclude_user is not None:
        rows = [r for r in rows if r.user_id != exclude_user]
    if near:
        rows = [r for r in rows if _haversine_m(r.lat, r.lon, near[0], near[1]) <= radius_m]
        rows.sort(key=lambda r: _haversine_m(r.lat, r.lon, near[0], near[1]))
    else:
        rows.sort(key=lambda r: r.created_at or datetime.min.replace(tzinfo=UTC), reverse=True)
    return [report_item(session, r, viewer_id, near) for r in rows[:limit]]
