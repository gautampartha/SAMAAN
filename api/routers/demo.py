"""Demo mode: honest counters and an in-process reset to the "fresh demo" state.

GET  /demo/status  counts computed from the DB (nothing invented; synthetic rows reported apart).
POST /demo/reset   removes everything the demo audience adds during a run (reports, votes, rides,
                   own/report photos and what was derived from them) and restores the seeded
                   synthetic overlay, then recomputes coverage/states and the routing context.

What reset deletes / keeps (also summarised in the response's `deleted` block):
  deleted : Report, Vote, Ride, RideSample, EdgeRideStat rows; Coverage rows from wheels;
            Image rows with source own/report, their Detection rows and photo files under
            data/raw/own and data/raw/reports; non-synthetic barriers that came from reports
            (sources report:<id>), from rides (ride:<id>:w<n>, status suspected) or only from
            detections of the deleted photos.
  kept    : the graph, Mapillary images + their detections and barriers, synthetic seed rows
            (barriers, coverage, demo route), missions, Meta. User rows are kept so a phone's
            stored identity survives; their trust_score goes back to the configured initial
            (team members at/above team_initial keep team_initial).
  restored: synthetic barriers closed by a verified fixed report -> active again, fixed_at None,
            sources trimmed to seed:* (an `expired` temporary seed barrier stays expired: that
            is age, which the recompute would re-apply anyway).
            Severity/confidence bumps from duplicate reports on a seed barrier are not undone;
            `make seed` is the full rebuild.
Refuses with 409 while an on-demand zone (POST /zones/rebuild) is active: the seed only exists
for the configured zone. Idempotent: a second call deletes nothing and returns the same status.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, delete, func, select

from api.db import get_session
from api.models import (
    Barrier,
    Coverage,
    Detection,
    EdgeRideStat,
    FootpathEdge,
    Image,
    Meta,
    Mission,
    Report,
    Ride,
    RideSample,
    User,
    Vote,
)
from common import config
from common.paths import ROOT

log = logging.getLogger("samaan.demo")
router = APIRouter(prefix="/demo", tags=["demo"])

USER_PHOTO_SOURCES = ("own", "report")


def _count(session: Session, model: Any, *where: Any) -> int:
    q = select(func.count(model.id))
    for w in where:
        q = q.where(w)
    return int(session.exec(q).one())


def _pct(part: int, total: int) -> float:
    return round(100.0 * part / total, 1) if total else 0.0


def status_payload(session: Session) -> dict[str, Any]:
    meta = {m.key: m.value for m in session.exec(select(Meta)).all()}
    edges = session.exec(select(FootpathEdge.state, FootpathEdge.state_synthetic)).all()
    edges_total = len(edges)
    known_any = sum(1 for s, _ in edges if s != "unknown")
    known_real = sum(1 for s, syn in edges if s != "unknown" and not syn)
    states = {k: sum(1 for s, _ in edges if s == k) for k in ("clear", "blocked", "unknown")}
    img_synth = _count(session, Image, Image.synthetic == True)
    bar_synth = _count(session, Barrier, Barrier.synthetic == True)
    cov_synth = _count(session, Coverage, Coverage.synthetic == True)
    z = config.zone()
    return {
        "zone": {"name": z["name"], "display_name": z["display_name"], "on_demand": bool(z.get("on_demand", False))},
        "synthetic_present": meta.get("synthetic") == "true" or bar_synth > 0 or cov_synth > 0 or img_synth > 0,
        "images": {
            "total": _count(session, Image),
            "real": _count(session, Image, Image.synthetic == False),
            "synthetic": img_synth,
            "mapillary": _count(session, Image, Image.source == "mapillary"),
            "own_photo": _count(session, Image, Image.source == "own"),
            "report_photo": _count(session, Image, Image.source == "report"),
        },
        "barriers": {
            "total": _count(session, Barrier),
            "real": _count(session, Barrier, Barrier.synthetic == False),
            "synthetic": bar_synth,
            "active": _count(session, Barrier, Barrier.status == "active"),
        },
        "coverage": {
            "edges_total": edges_total,
            "edges_known_real": known_real,
            "edges_known_any": known_any,
            "pct_real": _pct(known_real, edges_total),
            "pct_any": _pct(known_any, edges_total),
            "states": states,
        },
        "reports": {
            "total": _count(session, Report),
            "pending": _count(session, Report, Report.status == "pending"),
            "verified": _count(session, Report, Report.status == "verified"),
            "rejected": _count(session, Report, Report.status == "rejected"),
            "fixed": _count(session, Report, Report.kind == "fixed"),
        },
        "votes": _count(session, Vote),
        "users": _count(session, User),
        "rides": _count(session, Ride),
        "missions": _count(session, Mission),
    }


@router.get("/status")
def demo_status(session: Session = Depends(get_session)) -> dict[str, Any]:
    return status_payload(session)


def _unlink_photo(rel: str | None) -> bool:
    if not rel:
        return False
    p = (ROOT / rel).resolve()
    if ROOT.resolve() not in p.parents or not p.is_file():
        return False
    p.unlink()
    return True


def _prune_empty_dirs(root: Path) -> None:
    if not root.is_dir():
        return
    for d in sorted((p for p in root.rglob("*") if p.is_dir()), reverse=True):
        try:
            d.rmdir()  # only succeeds when empty
        except OSError:
            pass


def _source_gone(src: str, photo_ids: list[int], det_ids: set[int]) -> bool:
    """A barrier source that reset removes: a report, a ride jolt, or a deleted photo/detection."""
    kind, _, ident = src.partition(":")
    if kind in ("report", "report_fixed", "ride"):
        return True
    if kind == "image" and ident.isdigit():
        return int(ident) in photo_ids
    if kind == "detection" and ident.isdigit():
        return int(ident) in det_ids
    return False


def reset_demo(session: Session) -> dict[str, int]:
    """Delete user-added rows, restore the seed barriers. Returns what was deleted (counts)."""
    deleted: dict[str, int] = {}
    t = config.pipeline()["reports"]["trust"]

    # 1. reports + votes
    deleted["votes"] = _count(session, Vote)
    deleted["reports"] = _count(session, Report)
    session.exec(delete(Vote))
    session.exec(delete(Report))

    # 2. rides and everything derived from them
    deleted["rides"] = _count(session, Ride)
    deleted["ride_samples"] = _count(session, RideSample)
    deleted["edge_ride_stats"] = _count(session, EdgeRideStat)
    deleted["coverage_wheel"] = _count(session, Coverage, Coverage.source == "wheel")
    session.exec(delete(RideSample))
    session.exec(delete(Ride))
    session.exec(delete(EdgeRideStat))
    session.exec(delete(Coverage).where(Coverage.source == "wheel"))  # type: ignore[arg-type]

    # 3. own / report photos, their detections and files (Mapillary stays)
    photos = session.exec(select(Image).where(Image.source.in_(USER_PHOTO_SOURCES))).all()  # type: ignore[attr-defined]
    photo_ids = [i.id for i in photos]
    files = sum(_unlink_photo(i.path) for i in photos)
    det_ids: set[int] = set()
    if photo_ids:
        det_ids = {d.id for d in session.exec(select(Detection).where(Detection.image_id.in_(photo_ids))).all()}  # type: ignore[attr-defined]
        session.exec(delete(Detection).where(Detection.image_id.in_(photo_ids)))  # type: ignore[attr-defined]
        session.exec(delete(Image).where(Image.id.in_(photo_ids)))  # type: ignore[attr-defined]
    deleted["images_own_or_report"] = len(photo_ids)
    deleted["photo_files"] = files
    deleted["detections"] = len(det_ids)
    from api.routers.images import OWN_DIR
    from api.services.reports import REPORT_DIR

    _prune_empty_dirs(OWN_DIR)
    _prune_empty_dirs(REPORT_DIR)

    # 4. barriers: drop the ones the audience created, restore the seeded ones
    deleted["barriers"] = 0
    restored = 0
    for b in session.exec(select(Barrier)).all():
        sources = list(b.sources or [])
        if b.synthetic:
            seed_sources = [s for s in sources if s.startswith("seed:")]
            # `expired` is time-based (recompute re-applies it), so only a report-closed one is reopened
            if b.status == "fixed" or b.fixed_at is not None or seed_sources != sources:
                b.status = "active" if b.status == "fixed" else b.status
                b.fixed_at, b.sources = None, seed_sources
                session.add(b)
                restored += 1
            continue
        gone = [s for s in sources if _source_gone(s, photo_ids, det_ids)]
        remaining = [s for s in sources if s not in gone]
        if gone and not remaining:
            session.delete(b)
            deleted["barriers"] += 1
        elif remaining != sources:
            b.sources = remaining  # e.g. a Mapillary-detected barrier a report had confirmed
            session.add(b)
    deleted["barriers_restored"] = restored

    # 5. users stay (phones keep their identity); trust goes back to the configured start
    initial, team = float(t["initial"]), float(t["team_initial"])
    for u in session.exec(select(User)).all():
        want = team if u.trust_score >= team else initial
        if u.trust_score != want:
            u.trust_score = want
            session.add(u)
    session.commit()
    return deleted


@router.post("/reset")
def demo_reset(request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    z = config.zone()
    if z.get("on_demand"):
        raise HTTPException(409, f"demo reset only applies to the configured zone; {z['name']!r} was built on demand "
                                 "(POST /zones/reset first)")
    deleted = reset_demo(session)
    from api.routers.images import recompute_all

    recompute = recompute_all(request)  # coverage + states + expiry, then graph + routing context
    session.expire_all()
    log.info("demo reset: deleted=%s recompute=%s", deleted, recompute)
    return {"status": "reset", "deleted": deleted, "recompute": recompute, **status_payload(session)}
