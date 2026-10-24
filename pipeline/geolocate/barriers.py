"""Detections -> barriers (plan 6.4 step 6, 3c): cluster per class and edge (1-D along the edge,
eps 4 m), one barrier per cluster, confidence grows with sightings, severity = median of human
labels when any exist else the class default, time-of-day profile for temporary classes.

Only detector-derived barriers (sources 'detection:<id>') are rebuilt here; report-based
barriers (P7) are left untouched.
"""
from __future__ import annotations

import logging
import statistics
from datetime import UTC, datetime
from typing import Any

from shapely import wkt
from sqlmodel import Session, select

from api.models import Barrier, Detection, FootpathEdge, Image
from common import config
from common.crs import to_wgs84

log = logging.getLogger(__name__)


def cluster_1d(positions: list[tuple[int, float]], eps: float) -> list[list[int]]:
    """positions: (item id, position along edge). Sorted gap-split clustering = DBSCAN with
    min_samples=1 in one dimension."""
    if not positions:
        return []
    ordered = sorted(positions, key=lambda p: p[1])
    clusters: list[list[int]] = [[ordered[0][0]]]
    last = ordered[0][1]
    for pid, pos in ordered[1:]:
        if pos - last <= eps:
            clusters[-1].append(pid)
        else:
            clusters.append([pid])
        last = pos
    return clusters


def cluster_confidence(snap_confs: list[float], bcfg: dict[str, Any]) -> float:
    base = max(snap_confs) if snap_confs else float(bcfg["base_confidence"])
    extra = float(bcfg["confidence_per_extra_sighting"]) * (len(snap_confs) - 1)
    return round(min(float(bcfg["max_confidence"]), max(float(bcfg["base_confidence"]) * 0.5, base + extra)), 3)


def time_profile(timestamps: list[datetime], min_sightings: int) -> list[float]:
    """P(present at hour h) from sighting hours: a smoothed, max-normalised histogram. With few
    sightings a flat 0.5 is returned (unknown rather than confident)."""
    if len(timestamps) < min_sightings:
        return [0.5] * 24
    counts = [0.0] * 24
    for t in timestamps:
        counts[t.hour] += 1.0
    smoothed = [(counts[(h - 1) % 24] * 0.5 + counts[h] + counts[(h + 1) % 24] * 0.5) for h in range(24)]
    m = max(smoothed) or 1.0
    return [round(min(1.0, 0.1 + 0.9 * v / m), 2) for v in smoothed]


def build_barriers(session: Session, pipeline_cfg: dict[str, Any] | None = None, taxonomy_cfg: dict[str, Any] | None = None,
                   now: datetime | None = None) -> dict[str, Any]:
    pipeline_cfg = pipeline_cfg or config.pipeline()
    taxonomy_cfg = taxonomy_cfg or config.taxonomy()
    now = now or datetime.now(UTC)
    bcfg = pipeline_cfg["barriers"]
    eps = float(pipeline_cfg["snapping"]["cluster_eps_m"])
    temporary = config.temporary_classes(taxonomy_cfg)
    # remove previous detector-derived barriers (real ones only)
    old = [b for b in session.exec(select(Barrier).where(Barrier.synthetic == False)).all()
           if b.sources and all(s.startswith("detection:") for s in b.sources)]
    for b in old:
        session.delete(b)
    session.flush()
    dets = [d for d in session.exec(select(Detection).where(Detection.synthetic == False)).all()
            if d.assigned_edge_id is not None and d.position_along_edge_m is not None]
    images = {i.id: i for i in session.exec(select(Image)).all()}
    edges = {e.id: e for e in session.exec(select(FootpathEdge)).all()}
    groups: dict[tuple[str, int], list[Detection]] = {}
    for d in dets:
        groups.setdefault((d.class_id, d.assigned_edge_id), []).append(d)
    created = 0
    for (cls, edge_id), group in groups.items():
        by_id = {d.id: d for d in group}
        for cluster in cluster_1d([(d.id, d.position_along_edge_m) for d in group], eps):
            members = [by_id[i] for i in cluster]
            pos = statistics.median(d.position_along_edge_m for d in members)
            edge = edges[edge_id]
            pt = to_wgs84(wkt.loads(edge.geom_m_wkt).interpolate(pos))
            labelled = [d.severity for d in members if getattr(d, "severity", None)]
            severity = round(statistics.median(labelled)) if labelled else int(bcfg["default_severity"].get(cls, 3))
            stamps = [images[d.image_id].captured_at for d in members if d.image_id in images and images[d.image_id].captured_at]
            is_temp = cls in temporary
            session.add(Barrier(
                class_id=cls, severity=severity, tags=[], edge_id=edge_id, side=edge.side, position_along_edge_m=float(pos),
                lat=pt.y, lon=pt.x, permanent=not is_temp,
                time_profile=time_profile(stamps, int(bcfg["temporary_min_sightings_for_profile"])) if is_temp else None,
                status="active", confidence=cluster_confidence([d.snap_confidence or 0.5 for d in members], bcfg),
                sources=[f"detection:{d.id}" for d in members], created_at=min(stamps) if stamps else now,
                last_seen_at=max(stamps) if stamps else now, synthetic=False,
            ))
            created += 1
    session.commit()
    stats = {"detections_used": len(dets), "barriers_created": created, "barriers_removed": len(old)}
    log.info("barriers: %s", stats)
    return stats
