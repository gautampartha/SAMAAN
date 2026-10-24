"""Coverage from images (plan 6.2): an edge counts as observed when at least K images have
their camera within `camera_max_distance_m` of the edge AND a view cone (heading ± HFOV/2,
range `view_range_m`) intersecting it. Sidewalk sides are separate edges in the P1 graph, so
coverage is per edge and inherits the edge's side.

Only real images (synthetic=False) with usable GPS take part. Images without a heading are
skipped unless the camera is spherical (360°), which sees a full disc.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime
from typing import Any

from shapely import STRtree, wkt
from shapely.geometry import Point, Polygon
from sqlmodel import Session, delete, select

from api.models import Coverage, FootpathEdge, Image
from common import config
from common.crs import lonlat_to_xy

log = logging.getLogger(__name__)


def view_cone(x: float, y: float, heading_deg: float | None, hfov_deg: float, range_m: float, n_arc: int = 12) -> Polygon:
    """Sector polygon seen from (x, y). heading None or hfov >= 360 -> full disc."""
    if heading_deg is None or hfov_deg >= 360:
        return Point(x, y).buffer(range_m, quad_segs=16)
    half = hfov_deg / 2.0
    pts = [(x, y)]
    for i in range(n_arc + 1):
        b = math.radians(heading_deg - half + (2 * half) * i / n_arc)
        pts.append((x + range_m * math.sin(b), y + range_m * math.cos(b)))
    return Polygon(pts)


def image_sees(img: Image, edge_geom_m: Any, cov_cfg: dict[str, Any]) -> bool:
    """Does one image observe one edge (metric geometry)? Pure function for tests."""
    if img.gps_accuracy_m is not None and img.gps_accuracy_m > float(cov_cfg["max_gps_accuracy_m"]):
        return False
    x, y = lonlat_to_xy(img.lon, img.lat)
    if edge_geom_m.distance(Point(x, y)) > float(cov_cfg["camera_max_distance_m"]):
        return False
    hfov = float(img.hfov_deg or cov_cfg["default_hfov_deg"])
    if img.heading_deg is None and (img.camera_type != "spherical" and hfov < 360):
        return False
    cone = view_cone(x, y, img.heading_deg, hfov, float(cov_cfg["view_range_m"]))
    return cone.intersects(edge_geom_m)


def compute_coverage(session: Session, cov_cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Recompute image-based Coverage rows for every edge. Returns a summary."""
    cov_cfg = cov_cfg or config.pipeline()["coverage"]
    k = int(cov_cfg["min_images_k"])
    edges = session.exec(select(FootpathEdge)).all()
    images = [i for i in session.exec(select(Image)).all() if not i.synthetic]
    geoms = [wkt.loads(e.geom_m_wkt) for e in edges]
    tree = STRtree(geoms) if geoms else None
    counts: dict[int, int] = {}
    last: dict[int, datetime] = {}
    usable = 0
    search = float(cov_cfg["camera_max_distance_m"])
    for img in images:
        if img.gps_accuracy_m is not None and img.gps_accuracy_m > float(cov_cfg["max_gps_accuracy_m"]):
            continue
        hfov = float(img.hfov_deg or cov_cfg["default_hfov_deg"])
        if img.heading_deg is None and img.camera_type != "spherical" and hfov < 360:
            continue
        usable += 1
        if tree is None:
            continue
        x, y = lonlat_to_xy(img.lon, img.lat)
        cam = Point(x, y)
        cone = view_cone(x, y, img.heading_deg, hfov, float(cov_cfg["view_range_m"]))
        for idx in tree.query(cam.buffer(search)):
            g = geoms[int(idx)]
            if g.distance(cam) <= search and cone.intersects(g):
                e = edges[int(idx)]
                counts[e.id] = counts.get(e.id, 0) + 1
                if img.captured_at and (e.id not in last or img.captured_at > last[e.id]):
                    last[e.id] = img.captured_at
    session.exec(delete(Coverage).where(Coverage.source == "image"))  # type: ignore[arg-type]
    observed = 0
    for e in edges:
        n = counts.get(e.id, 0)
        if n == 0:
            continue
        obs = n >= k
        observed += int(obs)
        session.add(Coverage(edge_id=e.id, side=e.side, observed=obs, n_images=n, last_observed_at=last.get(e.id),
                             source="image", synthetic=False))
    session.commit()
    summary = {"images_total": len(images), "images_usable": usable, "edges": len(edges),
               "edges_with_images": len(counts), "edges_observed": observed, "k": k}
    log.info("coverage: %s", summary)
    return summary
