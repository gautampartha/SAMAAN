"""Expire temporary barriers (plan 3c / Phase 2): a temporary barrier not seen again within
`temporary_expiry_days` (config/taxonomy.yaml) becomes `expired` and stops affecting routes."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlmodel import Session, select

from api.models import Barrier
from common import config


def expire_temporary_barriers(session: Session, now: datetime | None = None) -> dict[str, int]:
    now = now or datetime.now(UTC)
    days = int(config.taxonomy().get("temporary_expiry_days", 14))
    temporary = config.temporary_classes()
    expired = 0
    for b in session.exec(select(Barrier).where(Barrier.status == "active")).all():
        if b.class_id not in temporary or b.permanent:
            continue
        last = b.last_seen_at or b.created_at
        if last is None:
            continue
        if last.tzinfo is None:
            last = last.replace(tzinfo=UTC)
        if now - last > timedelta(days=days):
            b.status = "expired"
            session.add(b)
            expired += 1
    session.commit()
    return {"expired": expired, "expiry_days": days}
