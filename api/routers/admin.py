"""Authority dashboard API (/admin): triage citizen reports, track barriers, assign field workers
and close work orders. Closing a work order as `done` marks its barrier fixed, recomputes footpath
states and reloads routing, so the citizen app's routes change at once.

Auth: when SAMAAN_ADMIN_TOKEN is set, every call needs header `X-Admin-Token: <token>`. Without it
the API is open (laptop / demo) and /admin/summary says so, so the dashboard can show a warning.
"""

from __future__ import annotations

import hmac
import os
from datetime import UTC, date, datetime, timedelta
from statistics import median
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from api.db import get_session
from api.models import Barrier, Report, User, Vote, Worker, WorkOrder
from api.services import reports as svc
from common import config
from pipeline.state.recompute import recompute_states

TOKEN_ENV = "SAMAAN_ADMIN_TOKEN"
STATUSES = ("open", "assigned", "in_progress", "done", "cant_fix", "cancelled")
OPEN_STATUSES = ("open", "assigned", "in_progress")
PRIORITIES = ("low", "normal", "high", "urgent")
# allowed status changes; done / cancelled are final, cant_fix can be reopened
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "open": ("assigned", "cancelled"),
    "assigned": ("in_progress", "done", "cant_fix", "cancelled", "open"),
    "in_progress": ("done", "cant_fix", "cancelled", "assigned"),
    "cant_fix": ("assigned", "cancelled"),
    "done": (),
    "cancelled": (),
}


def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    token = os.environ.get(TOKEN_ENV, "")
    if not token:
        return
    if not x_admin_token or not hmac.compare_digest(x_admin_token, token):
        raise HTTPException(401, "admin token required")


router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).isoformat()


def _aware(dt: datetime | None) -> datetime | None:
    return None if dt is None else (dt if dt.tzinfo else dt.replace(tzinfo=UTC))


def _refresh_routing(request: Request, session: Session, now: datetime) -> None:
    from api.services.routing import build_context
    from pipeline.graph.osm import load_nx_from_db

    recompute_states(session, now=now)
    session.commit()
    request.app.state.graph = load_nx_from_db(session)
    request.app.state.routing = build_context(session)


def _worker_out(w: Worker, open_jobs: int = 0) -> dict[str, Any]:
    return {"id": w.id, "name": w.name, "phone": w.phone, "department": w.department, "area": w.area,
            "active": w.active, "open_jobs": open_jobs, "created_at": _iso(w.created_at)}


def _order_out(o: WorkOrder, workers: dict[int, Worker]) -> dict[str, Any]:
    w = workers.get(o.worker_id) if o.worker_id else None
    return {"id": o.id, "barrier_id": o.barrier_id, "worker_id": o.worker_id, "worker_name": w.name if w else None,
            "status": o.status, "priority": o.priority, "due_date": o.due_date, "note": o.note,
            "resolution_note": o.resolution_note, "created_by": o.created_by, "created_at": _iso(o.created_at),
            "updated_at": _iso(o.updated_at), "completed_at": _iso(o.completed_at), "history": o.history or [],
            "overdue": bool(o.due_date and o.status in OPEN_STATUSES and o.due_date < date.today().isoformat())}


def _barrier_out(b: Barrier, names: dict[str, dict[str, str]], order: dict[str, Any] | None, n_reports: int, now: datetime) -> dict[str, Any]:
    created = _aware(b.created_at)
    return {"id": b.id, "class_id": b.class_id, "name_en": names.get(b.class_id, {}).get("en", b.class_id),
            "name_hi": names.get(b.class_id, {}).get("hi", b.class_id), "severity": b.severity, "status": b.status,
            "confidence": b.confidence, "lat": b.lat, "lon": b.lon, "edge_id": b.edge_id, "permanent": b.permanent,
            "synthetic": b.synthetic, "sources": b.sources or [], "note": b.note, "created_at": _iso(b.created_at),
            "fixed_at": _iso(b.fixed_at), "age_days": round((now - created).total_seconds() / 86400, 1) if created else None,
            "n_reports": n_reports, "work_order": order}


def _orders_by_barrier(session: Session, workers: dict[int, Worker]) -> dict[int, dict[str, Any]]:
    """Latest work order per barrier (an open one wins over closed ones)."""
    out: dict[int, dict[str, Any]] = {}
    for o in session.exec(select(WorkOrder).order_by(WorkOrder.created_at)).all():
        cur = out.get(o.barrier_id)
        if cur is None or o.status in OPEN_STATUSES or cur["status"] not in OPEN_STATUSES:
            out[o.barrier_id] = _order_out(o, workers)
    return out


# ----------------------------------------------------------------------------- summary


@router.get("/summary")
def summary(session: Session = Depends(get_session)) -> dict[str, Any]:
    now = _now()
    reports = session.exec(select(Report)).all()
    barriers = session.exec(select(Barrier)).all()
    orders = session.exec(select(WorkOrder)).all()
    workers = session.exec(select(Worker)).all()
    by_status = {s: sum(1 for o in orders if o.status == s) for s in STATUSES}
    open_by_barrier = {o.barrier_id for o in orders if o.status in OPEN_STATUSES}
    active = [b for b in barriers if b.status == "active"]
    done = [o for o in orders if o.status == "done" and o.completed_at]
    # job turnaround: work order created -> closed as fixed (barrier "first seen" can be years old imagery)
    hours_to_close = [(_aware(o.completed_at) - _aware(o.created_at)).total_seconds() / 3600 for o in done if o.created_at]
    week_ago = now - timedelta(days=7)
    return {
        "auth": "token" if os.environ.get(TOKEN_ENV) else "open",
        "zone": config.zone().get("display_name"),
        "reports": {s: sum(1 for r in reports if r.status == s) for s in ("pending", "verified", "rejected")}
        | {"total": len(reports), "today": sum(1 for r in reports if r.created_at and _aware(r.created_at) >= now - timedelta(days=1))},
        "barriers": {"active": len(active), "active_real": sum(1 for b in active if not b.synthetic),
                     "active_synthetic": sum(1 for b in active if b.synthetic), "fixed": sum(1 for b in barriers if b.status == "fixed"),
                     "unassigned": sum(1 for b in active if b.id not in open_by_barrier),
                     "impassable": sum(1 for b in active if b.severity >= 5)},
        "work_orders": by_status | {"overdue": sum(1 for o in orders if o.due_date and o.status in OPEN_STATUSES and o.due_date < date.today().isoformat())},
        "fixed_last_7_days": sum(1 for o in done if _aware(o.completed_at) >= week_ago),
        # honest: null until at least one work order has been closed
        "median_hours_to_close": round(median(hours_to_close), 1) if hours_to_close else None,
        "workers": {"total": len(workers), "active": sum(1 for w in workers if w.active)},
    }


# ----------------------------------------------------------------------------- reports


@router.get("/reports")
def list_reports(status: str = "pending", limit: int = 100, session: Session = Depends(get_session)) -> dict[str, Any]:
    q = select(Report).order_by(Report.created_at.desc())
    if status != "all":
        q = q.where(Report.status == status)
    rows = session.exec(q.limit(max(1, min(limit, 500)))).all()
    users = {u.id: u for u in session.exec(select(User)).all()}
    out = []
    for r in rows:
        item = svc.report_item(session, r)
        u = users.get(r.user_id)
        item["reporter"] = {"name": u.display_name, "trust": round(u.trust_score, 2), "profile": u.profile} if u else None
        item["note"] = r.note
        item["kind"] = r.kind
        item["target_barrier_id"] = r.target_barrier_id
        item["resolved_at"] = _iso(r.resolved_at)
        item["sources_note"] = r.sources_note
        out.append(item)
    return {"count": len(out), "results": out}


class DecisionIn(BaseModel):
    decision: str = Field(pattern="^(verify|reject)$")
    note: str | None = Field(None, max_length=500)


@router.post("/reports/{report_id}/decision")
def decide(report_id: int, body: DecisionIn, request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Authority override of the citizen vote: verify (creates / updates / fixes the barrier) or reject."""
    r = session.get(Report, report_id)
    if r is None:
        raise HTTPException(404, "unknown report")
    if r.status != "pending":
        raise HTTPException(400, f"report already {r.status}")
    now = _now()
    votes = session.exec(select(Vote).where(Vote.report_id == r.id)).all()
    users = {u.id: u for u in session.exec(select(User).where(User.id.in_([v.user_id for v in votes] + [r.user_id]))).all()}
    svc.resolve(session, r, "verified" if body.decision == "verify" else "rejected", votes, users, now)
    r.sources_note = f"authority {body.decision}" + (f": {body.note}" if body.note else "")
    session.add(r)
    _refresh_routing(request, session, now)
    session.refresh(r)
    return {"report_id": r.id, "status": r.status, "barrier_id": r.barrier_id}


# ----------------------------------------------------------------------------- barriers


@router.get("/barriers")
def list_barriers(status: str = "active", include_synthetic: bool = True, session: Session = Depends(get_session)) -> dict[str, Any]:
    now = _now()
    names = config.class_names()
    workers = {w.id: w for w in session.exec(select(Worker)).all()}
    orders = _orders_by_barrier(session, workers)
    q = select(Barrier)
    if status != "all":
        q = q.where(Barrier.status == status)
    rows = session.exec(q).all()
    if not include_synthetic:
        rows = [b for b in rows if not b.synthetic]
    report_counts: dict[int, int] = {}
    for r in session.exec(select(Report)).all():
        bid = r.barrier_id or r.duplicate_of_barrier_id or r.target_barrier_id
        if bid:
            report_counts[bid] = report_counts.get(bid, 0) + 1
    out = [_barrier_out(b, names, orders.get(b.id), report_counts.get(b.id, 0), now) for b in rows]
    # most urgent first: no open order, high severity, real before synthetic, oldest
    out.sort(key=lambda x: (x["work_order"] is not None and x["work_order"]["status"] in OPEN_STATUSES, -x["severity"], x["synthetic"], x["created_at"] or ""))
    return {"count": len(out), "results": out}


# ----------------------------------------------------------------------------- workers


class WorkerIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    phone: str | None = Field(None, max_length=30)
    department: str | None = Field(None, max_length=80)
    area: str | None = Field(None, max_length=80)


class WorkerPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    phone: str | None = Field(None, max_length=30)
    department: str | None = Field(None, max_length=80)
    area: str | None = Field(None, max_length=80)
    active: bool | None = None


@router.get("/workers")
def list_workers(session: Session = Depends(get_session)) -> dict[str, Any]:
    orders = session.exec(select(WorkOrder).where(WorkOrder.status.in_(OPEN_STATUSES))).all()
    counts: dict[int, int] = {}
    for o in orders:
        if o.worker_id:
            counts[o.worker_id] = counts.get(o.worker_id, 0) + 1
    rows = session.exec(select(Worker).order_by(Worker.name)).all()
    return {"results": [_worker_out(w, counts.get(w.id, 0)) for w in rows]}


@router.post("/workers", status_code=201)
def create_worker(body: WorkerIn, session: Session = Depends(get_session)) -> dict[str, Any]:
    w = Worker(name=body.name.strip(), phone=body.phone, department=body.department, area=body.area)
    session.add(w)
    session.commit()
    session.refresh(w)
    return _worker_out(w)


@router.patch("/workers/{worker_id}")
def update_worker(worker_id: int, body: WorkerPatch, session: Session = Depends(get_session)) -> dict[str, Any]:
    w = session.get(Worker, worker_id)
    if w is None:
        raise HTTPException(404, "unknown worker")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(w, k, v)
    session.add(w)
    session.commit()
    session.refresh(w)
    return _worker_out(w)


# ----------------------------------------------------------------------------- work orders


class OrderIn(BaseModel):
    barrier_id: int
    worker_id: int | None = None
    priority: str = Field("normal", pattern="^(low|normal|high|urgent)$")
    due_date: date | None = None
    note: str | None = Field(None, max_length=500)
    created_by: str | None = Field(None, max_length=80)


class OrderPatch(BaseModel):
    status: str | None = Field(None, pattern="^(open|assigned|in_progress|done|cant_fix|cancelled)$")
    worker_id: int | None = None
    priority: str | None = Field(None, pattern="^(low|normal|high|urgent)$")
    due_date: date | None = None
    note: str | None = Field(None, max_length=500)
    resolution_note: str | None = Field(None, max_length=500)
    by: str | None = Field(None, max_length=80)


def _event(o: WorkOrder, now: datetime, status: str, by: str | None, note: str | None) -> None:
    o.history = list(o.history or []) + [{"at": _iso(now), "status": status, "by": by, "note": note}]


@router.get("/workorders")
def list_orders(status: str = "open_all", session: Session = Depends(get_session)) -> dict[str, Any]:
    workers = {w.id: w for w in session.exec(select(Worker)).all()}
    q = select(WorkOrder).order_by(WorkOrder.created_at.desc())
    if status == "open_all":
        q = q.where(WorkOrder.status.in_(OPEN_STATUSES))
    elif status != "all":
        q = q.where(WorkOrder.status == status)
    rows = session.exec(q).all()
    names = config.class_names()
    barriers = {b.id: b for b in session.exec(select(Barrier).where(Barrier.id.in_([o.barrier_id for o in rows]))).all()} if rows else {}
    out = []
    for o in rows:
        item = _order_out(o, workers)
        b = barriers.get(o.barrier_id)
        item["barrier"] = ({"class_id": b.class_id, "name_en": names.get(b.class_id, {}).get("en", b.class_id),
                            "name_hi": names.get(b.class_id, {}).get("hi", b.class_id), "severity": b.severity,
                            "lat": b.lat, "lon": b.lon, "status": b.status, "synthetic": b.synthetic} if b else None)
        out.append(item)
    return {"count": len(out), "results": out}


@router.post("/workorders", status_code=201)
def create_order(body: OrderIn, session: Session = Depends(get_session)) -> dict[str, Any]:
    b = session.get(Barrier, body.barrier_id)
    if b is None:
        raise HTTPException(404, "unknown barrier")
    if b.status != "active":
        raise HTTPException(400, f"barrier is {b.status}")
    existing = session.exec(select(WorkOrder).where(WorkOrder.barrier_id == b.id, WorkOrder.status.in_(OPEN_STATUSES))).first()
    if existing:
        raise HTTPException(409, f"barrier already has open work order {existing.id}")
    if body.worker_id is not None:
        w = session.get(Worker, body.worker_id)
        if w is None or not w.active:
            raise HTTPException(400, "unknown or inactive worker")
    now = _now()
    status = "assigned" if body.worker_id else "open"
    o = WorkOrder(barrier_id=b.id, worker_id=body.worker_id, status=status, priority=body.priority,
                  due_date=body.due_date.isoformat() if body.due_date else None, note=body.note,
                  created_by=body.created_by, created_at=now, updated_at=now)
    _event(o, now, status, body.created_by, body.note)
    session.add(o)
    session.commit()
    session.refresh(o)
    return _order_out(o, {w.id: w for w in session.exec(select(Worker)).all()})


@router.patch("/workorders/{order_id}")
def update_order(order_id: int, body: OrderPatch, request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    o = session.get(WorkOrder, order_id)
    if o is None:
        raise HTTPException(404, "unknown work order")
    now = _now()
    data = body.model_dump(exclude_unset=True)
    if "worker_id" in data and data["worker_id"] is not None:
        w = session.get(Worker, data["worker_id"])
        if w is None or not w.active:
            raise HTTPException(400, "unknown or inactive worker")
    new_status = data.get("status")
    if new_status is None and "worker_id" in data and o.status == "open" and data["worker_id"] is not None:
        new_status = "assigned"  # assigning a worker to an open order
    if new_status and new_status != o.status:
        if new_status not in TRANSITIONS.get(o.status, ()):
            raise HTTPException(400, f"cannot go from {o.status} to {new_status}")
        if new_status in ("assigned", "in_progress") and not (data.get("worker_id") or o.worker_id):
            raise HTTPException(400, "assign a worker first")
    for k in ("worker_id", "priority", "note", "resolution_note"):
        if k in data:
            setattr(o, k, data[k])
    if "due_date" in data:
        o.due_date = data["due_date"].isoformat() if data["due_date"] else None
    barrier_changed = False
    if new_status and new_status != o.status:
        o.status = new_status
        _event(o, now, new_status, data.get("by"), data.get("resolution_note") or data.get("note"))
        if new_status == "done":
            o.completed_at = now
            b = session.get(Barrier, o.barrier_id)
            if b is not None and b.status == "active":
                b.status, b.fixed_at = "fixed", now
                b.sources = list(b.sources or []) + [f"workorder:{o.id}"]
                session.add(b)
                barrier_changed = True
    o.updated_at = now
    session.add(o)
    session.commit()
    if barrier_changed:
        _refresh_routing(request, session, now)
    session.refresh(o)
    return _order_out(o, {w.id: w for w in session.exec(select(Worker)).all()})
