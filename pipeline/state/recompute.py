"""Segment state recompute (plan 6.5) from the current Coverage and Barrier tables.

Real coverage (source image/wheel/report) wins over seeded coverage (source seed) for the same
edge; the edge's `state_synthetic` flag records which one decided. Run after any ingest,
coverage, report or ride update.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlmodel import Session, select

from api.models import Barrier, Coverage, FootpathEdge
from common import config
from common.state import compute_edge_state, impassable_for_any_profile

REAL_SOURCES = ("image", "wheel", "report")


def recompute_states(session: Session, now: datetime | None = None, profiles_cfg: dict[str, Any] | None = None,
                     pipeline_cfg: dict[str, Any] | None = None) -> dict[str, int]:
    now = now or datetime.now(UTC)
    profiles_cfg = profiles_cfg or config.profiles()
    pipeline_cfg = pipeline_cfg or config.pipeline()
    staleness = int(pipeline_cfg["state"]["staleness_days_permanent"])
    edges = session.exec(select(FootpathEdge)).all()
    cov_real: dict[int, Coverage] = {}
    cov_seed: dict[int, Coverage] = {}
    for c in session.exec(select(Coverage)).all():
        target = cov_real if c.source in REAL_SOURCES else cov_seed
        prev = target.get(c.edge_id)
        if prev is None or (c.observed and not prev.observed) or (
            c.observed == prev.observed and (c.last_observed_at or now) > (prev.last_observed_at or now)
        ):
            target[c.edge_id] = c
    by_edge: dict[int, list[dict[str, Any]]] = {}
    real_blocking: set[int] = set()  # edges with a real (non-synthetic) active barrier that blocks some profile
    for b in session.exec(select(Barrier)).all():
        by_edge.setdefault(b.edge_id, []).append({"class": b.class_id, "severity": b.severity, "status": b.status,
                                                  "confidence": b.confidence})
        if not b.synthetic and b.status == "active" and impassable_for_any_profile(profiles_cfg, b.class_id, int(b.severity)):
            real_blocking.add(b.edge_id)
    counts = {"clear": 0, "blocked": 0, "unknown": 0, "from_real_coverage": 0, "from_seed_coverage": 0}
    for e in edges:
        c = cov_real.get(e.id) or cov_seed.get(e.id)
        observed = bool(c and c.observed)
        last = c.last_observed_at if c else None
        state, conf = compute_edge_state(by_edge.get(e.id, []), observed, last, profiles_cfg, staleness, now)
        e.state, e.state_confidence = state, conf
        e.last_observed_at = last
        e.observed_by = (c.source if c and c.source in REAL_SOURCES else ("image" if c else None))
        if state == "blocked":
            synthetic = e.id not in real_blocking  # a real blocking barrier makes the state real
        else:
            synthetic = c is not None and c.source == "seed"
        e.state_synthetic = bool(synthetic)
        counts[state] += 1
        if c is not None:
            counts["from_real_coverage" if c.source in REAL_SOURCES else "from_seed_coverage"] += 1
    session.commit()
    return counts
