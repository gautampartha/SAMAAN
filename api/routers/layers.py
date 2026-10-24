"""GeoJSON layers: footpaths (by state), barriers, coverage, anchors, demo trip."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from api.db import get_session
from api.geojson import collection, feature, point_feature
from api.models import (
    Anchor,
    Barrier,
    Coverage,
    DemoRoute,
    Detection,
    FootpathEdge,
    FootpathNode,
    Meta,
)
from common import config

router = APIRouter(prefix="/layers", tags=["layers"])


def _attribution(session: Session) -> dict[str, str]:
    meta = {m.key: m.value for m in session.exec(select(Meta)).all()}
    return {"osm": meta.get("osm_attribution", config.zone()["osm"]["attribution"]),
            "basemap": config.zone()["basemap"]["attribution"]}


def _iso(dt: Any) -> str | None:
    return dt.isoformat() if dt else None


@router.get("/footpaths")
def footpaths(session: Session = Depends(get_session)) -> dict[str, Any]:
    rows = session.exec(select(FootpathEdge)).all()
    feats = [feature(e.geom_wkt, {
        "id": e.id, "kind": e.kind, "state": e.state, "state_confidence": e.state_confidence,
        "length_m": round(e.length_m, 1), "side": e.side, "highway": e.highway,
        "synthesized": e.synthesized, "signal": e.signal,
        "kerb_ramp_start": e.kerb_ramp_start, "kerb_ramp_end": e.kerb_ramp_end,
        "parent_road_osm_id": e.parent_road_osm_id, "corner": bool(e.osm_tags.get("corner")),
        "last_observed_at": _iso(e.last_observed_at), "observed_by": e.observed_by,
        "synthetic": bool(e.synthetic or e.state_synthetic),
    }, fid=e.id) for e in rows]
    return collection(feats, _attribution(session), any(f["properties"]["synthetic"] for f in feats))


@router.get("/barriers")
def barriers(session: Session = Depends(get_session)) -> dict[str, Any]:
    names = config.class_names()
    rows = session.exec(select(Barrier)).all()
    feats = [point_feature(b.lon, b.lat, {
        "id": b.id, "class": b.class_id,
        "name_en": names.get(b.class_id, {}).get("en", b.class_id),
        "name_hi": names.get(b.class_id, {}).get("hi", b.class_id),
        "severity": b.severity, "tags": b.tags, "permanent": b.permanent, "status": b.status,
        "confidence": b.confidence, "edge_id": b.edge_id, "side": b.side,
        "position_along_edge_m": round(b.position_along_edge_m, 1),
        "time_profile": b.time_profile, "sources": b.sources, "note": b.note,
        "last_seen_at": _iso(b.last_seen_at), "synthetic": b.synthetic,
    }, fid=b.id) for b in rows]
    return collection(feats, _attribution(session), any(b.synthetic for b in rows))


@router.get("/coverage")
def coverage(session: Session = Depends(get_session)) -> dict[str, Any]:
    edges = {e.id: e for e in session.exec(select(FootpathEdge)).all()}
    rows = session.exec(select(Coverage)).all()
    feats = []
    for c in rows:
        e = edges.get(c.edge_id)
        if e is None:
            continue
        feats.append(feature(e.geom_wkt, {
            "edge_id": c.edge_id, "side": c.side, "observed": c.observed, "n_images": c.n_images,
            "last_observed_at": _iso(c.last_observed_at), "source": c.source, "synthetic": c.synthetic,
        }, fid=c.id))
    return collection(feats, _attribution(session), any(c.synthetic for c in rows))


@router.get("/anchors")
def anchors(session: Session = Depends(get_session)) -> dict[str, Any]:
    rows = session.exec(select(Anchor)).all()
    feats = [point_feature(a.lon, a.lat, {
        "id": a.id, "kind": a.kind, "name_en": a.name_en, "name_hi": a.name_hi,
        "node_id": a.node_id, "snap_distance_m": a.snap_distance_m, "verified": a.verified,
        "source": a.source, "synthetic": a.synthetic,
    }, fid=a.id) for a in rows]
    return collection(feats, _attribution(session), any(a.synthetic for a in rows))


@router.get("/detections")
def detections(session: Session = Depends(get_session), limit: int = 5000) -> dict[str, Any]:
    """Located detections (estimated positions) for debugging the snapper."""
    names = config.class_names()
    rows = [d for d in session.exec(select(Detection).limit(limit)).all() if d.est_lat is not None]
    feats = [point_feature(d.est_lon, d.est_lat, {
        "id": d.id, "image_id": d.image_id, "class": d.class_id, "name_en": names.get(d.class_id, {}).get("en", d.class_id),
        "score": round(d.score, 3), "est_distance_m": d.est_distance_m, "assigned_edge_id": d.assigned_edge_id,
        "naive_edge_id": d.naive_edge_id, "side": d.side, "snap_confidence": d.snap_confidence, "model": d.model,
        "synthetic": d.synthetic,
    }, fid=d.id) for d in rows]
    return collection(feats, _attribution(session), any(d.synthetic for d in rows))


@router.get("/demo")
def demo(session: Session = Depends(get_session)) -> dict[str, Any]:
    feats: list[dict[str, Any]] = []
    for r in session.exec(select(DemoRoute)).all():
        o = session.get(FootpathNode, r.origin_node_id)
        d = session.get(FootpathNode, r.destination_node_id)
        feats.append(point_feature(o.lon, o.lat, {"role": "origin", "demo_id": r.id, "anchor_id": r.origin_anchor_id,
                                                  "synthetic": True}, fid=f"{r.id}:origin"))
        feats.append(point_feature(d.lon, d.lat, {"role": "destination", "demo_id": r.id, "name_en": r.label_en,
                                                  "name_hi": r.label_hi, "synthetic": True}, fid=f"{r.id}:destination"))
        feats.append(feature(r.path_wkt, {"role": "path", "demo_id": r.id, "length_m": round(r.length_m, 1),
                                          "synthetic": True}, fid=f"{r.id}:path"))
    return collection(feats, _attribution(session), True)
