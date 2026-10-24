"""Geolocation and side-aware snapping of detections (plan 6.4 steps 1-5, 7, 8).

Pure functions on small dataclasses so every step is unit-testable; `geolocate_all` wires them
to the database. All metric work is EPSG:32643.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shapely import STRtree, wkt
from shapely.geometry import LineString, Point
from sqlmodel import Session, select

from api.models import Detection, FootpathEdge, Image, RoadCentreline
from common import config
from common.crs import lonlat_to_xy, xy_to_lonlat
from common.geo import bearing_deg, point_at_bearing, side_of_line

log = logging.getLogger(__name__)


@dataclass
class Camera:
    x: float
    y: float
    heading_deg: float | None
    pitch_deg: float | None
    hfov_deg: float
    width: int
    height: int
    gps_accuracy_m: float | None
    travel_bearing_deg: float | None = None  # from the previous image in the walk; None -> heading


@dataclass
class Box:
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2


@dataclass
class Located:
    x: float
    y: float
    bearing_deg: float
    distance_m: float
    distance_from_model: bool
    image_side: str | None  # L/R of the travel direction, from the box position in the frame


@dataclass
class Snapped:
    edge_id: int | None
    side: str | None            # road side (L/R in the sidewalk convention) or None
    position_along_edge_m: float | None
    snap_distance_m: float | None
    side_agreement: bool | None
    on_side: bool               # an edge on the computed side was found
    confidence: float


# ---------------------------------------------------------------- steps 1-3: bearing, distance, position


def vfov_deg(hfov_deg: float, width: int, height: int) -> float:
    return math.degrees(2 * math.atan(math.tan(math.radians(hfov_deg) / 2) * height / max(width, 1)))


def bearing_to_object(cam: Camera, box: Box) -> float:
    """Plan 6.4 step 1: bearing = heading + ((cx / W) - 0.5) * HFOV."""
    heading = cam.heading_deg if cam.heading_deg is not None else 0.0
    return (heading + ((box.cx / cam.width) - 0.5) * cam.hfov_deg) % 360.0


def ground_distance(cam: Camera, box: Box, geo_cfg: dict[str, Any], camera_height_m: float) -> tuple[float, bool]:
    """Plan 6.4 step 2: alpha = ((y_bottom / H) - 0.5) * VFOV + pitch; d = h / tan(alpha), clamped.
    Returns (distance, from_model). Falls back when the angle is at/above the horizon."""
    vfov = vfov_deg(cam.hfov_deg, cam.width, cam.height)
    pitch = cam.pitch_deg or 0.0
    # pitch sign: our capture page stores pitch_deg = beta - 90, negative when the phone tilts down,
    # i.e. the horizon moves UP in the frame -> everything looks further below the horizon.
    alpha = ((box.y2 / cam.height) - 0.5) * vfov - pitch
    if alpha < float(geo_cfg["min_angle_below_horizon_deg"]):
        return float(geo_cfg["distance_fallback_m"]), False
    d = camera_height_m / math.tan(math.radians(alpha))
    return min(max(d, float(geo_cfg["distance_min_m"])), float(geo_cfg["distance_max_m"])), True


def locate(cam: Camera, box: Box, geo_cfg: dict[str, Any], camera_height_m: float) -> Located:
    bearing = bearing_to_object(cam, box)
    d, from_model = ground_distance(cam, box, geo_cfg, camera_height_m)
    x, y = point_at_bearing(cam.x, cam.y, bearing, d)
    travel = cam.travel_bearing_deg if cam.travel_bearing_deg is not None else cam.heading_deg
    image_side = None
    if travel is not None:
        rel = (bearing - travel + 540.0) % 360.0 - 180.0  # (-180, 180]; negative = left of travel
        image_side = "L" if rel < 0 else "R"
    return Located(x, y, bearing, d, from_model, image_side)


# ---------------------------------------------------------------- step 4: side of road


class RoadIndex:
    def __init__(self, roads: list[RoadCentreline]):
        self.roads = roads
        self.geoms = [wkt.loads(r.geom_m_wkt) for r in roads]
        self.tree = STRtree(self.geoms) if self.geoms else None

    def nearest(self, pt: Point, max_m: float) -> tuple[RoadCentreline, LineString] | None:
        if self.tree is None:
            return None
        idx = int(self.tree.nearest(pt))
        if self.geoms[idx].distance(pt) > max_m:
            return None
        return self.roads[idx], self.geoms[idx]


def road_side(point: Point, road_geom: LineString, travel_bearing: float | None) -> tuple[str, str | None]:
    """(side in the sidewalk L/R convention = relative to the road's stored direction,
        side relative to the travel direction or None).

    The sidewalk convention follows the road geometry's orientation. For the cross-check we
    also express the side relative to travel: if the walker moves against the road direction,
    L/R flip."""
    side_stored = side_of_line(road_geom, point)
    if travel_bearing is None:
        return side_stored, None
    d = road_geom.project(point)
    a = road_geom.interpolate(max(d - 2.0, 0.0))
    b = road_geom.interpolate(min(d + 2.0, road_geom.length))
    road_bearing = bearing_deg(a.x, a.y, b.x, b.y)
    diff = abs((road_bearing - travel_bearing + 180.0) % 360.0 - 180.0)
    along = diff <= 90.0
    side_travel = side_stored if along else ("L" if side_stored == "R" else "R")
    return side_stored, side_travel


# ---------------------------------------------------------------- step 5 + 8: snapping


class EdgeIndex:
    def __init__(self, edges: list[FootpathEdge]):
        self.edges = edges
        self.geoms = [wkt.loads(e.geom_m_wkt) for e in edges]
        self.tree = STRtree(self.geoms) if self.geoms else None

    def candidates(self, pt: Point, max_m: float) -> list[tuple[FootpathEdge, LineString, float]]:
        if self.tree is None:
            return []
        out = []
        for idx in self.tree.query(pt.buffer(max_m)):
            g = self.geoms[int(idx)]
            d = g.distance(pt)
            if d <= max_m:
                out.append((self.edges[int(idx)], g, d))
        return sorted(out, key=lambda t: t[2])


def snap_side_aware(pt: Point, side: str | None, road: RoadCentreline | None, edges: EdgeIndex, max_m: float) -> tuple[FootpathEdge | None, LineString | None, float | None, bool]:
    """Nearest footpath edge on `side` within max_m, preferring the sidewalk of the matched road;
    falls back to any edge on that side, then (on_side=False) to any edge."""
    cands = edges.candidates(pt, max_m)
    if not cands:
        return None, None, None, False
    if side is not None:
        same_road = [c for c in cands if c[0].side == side and road is not None and c[0].parent_road_osm_id == road.osm_id]
        if same_road:
            e, g, d = same_road[0]
            return e, g, d, True
        on_side = [c for c in cands if c[0].side == side]
        if on_side:
            e, g, d = on_side[0]
            return e, g, d, True
    # crossings / footways carry side 'none': acceptable when nothing sided is near
    sideless = [c for c in cands if c[0].side == "none"]
    e, g, d = (sideless or cands)[0]
    return e, g, d, side is None


def snap_naive(cam_pt: Point, edges: EdgeIndex, max_m: float) -> tuple[FootpathEdge | None, float | None]:
    """Baseline (plan 6.4 step 8): nearest footpath edge to the CAMERA position, side ignored."""
    cands = edges.candidates(cam_pt, max_m)
    if not cands:
        return None, None
    return cands[0][0], cands[0][2]


def _ramp(v: float | None, good: float, bad: float) -> float:
    if v is None:
        return 0.5
    if v <= good:
        return 1.0
    if v >= bad:
        return 0.0
    return 1.0 - (v - good) / (bad - good)


def snap_confidence(cam: Camera, loc: Located, side_agreement: bool | None, on_side: bool, weights: dict[str, float]) -> float:
    """Plan 6.4 step 7 (sightings are added at the barrier level)."""
    c = (weights["gps_accuracy"] * _ramp(cam.gps_accuracy_m, 5.0, 25.0)
         + weights["distance"] * _ramp(loc.distance_m, 5.0, 25.0)
         + weights["side_agreement"] * (1.0 if side_agreement else 0.5 if side_agreement is None else 0.0)
         + weights["snapped_on_side"] * (1.0 if on_side else 0.0))
    return round(min(max(c, 0.0), 1.0), 3)


def snap_detection(cam: Camera, box: Box, roads: RoadIndex, edges: EdgeIndex, pipeline_cfg: dict[str, Any],
                   camera_height_m: float) -> tuple[Located, Snapped]:
    geo = pipeline_cfg["geolocation"]
    loc = locate(cam, box, geo, camera_height_m)
    pt = Point(loc.x, loc.y)
    travel = cam.travel_bearing_deg if cam.travel_bearing_deg is not None else cam.heading_deg
    hit = roads.nearest(pt, float(geo["road_search_m"]))
    side = side_travel = None
    road = None
    if hit is not None:
        road, rgeom = hit
        side, side_travel = road_side(pt, rgeom, travel)
    agreement = None if (side_travel is None or loc.image_side is None) else (side_travel == loc.image_side)
    edge, geom, dist, on_side = snap_side_aware(pt, side, road, edges, float(pipeline_cfg["snapping"]["max_snap_distance_m"]))
    conf = snap_confidence(cam, loc, agreement, on_side, geo["confidence"])
    if edge is None:
        return loc, Snapped(None, side, None, None, agreement, False, conf * 0.5)
    return loc, Snapped(edge.id, edge.side if edge.side != "none" else side, float(geom.project(pt)), dist, agreement, on_side, conf)


# ---------------------------------------------------------------- database wiring


def travel_bearings(images: list[Image], geo: dict[str, Any]) -> dict[int, float | None]:
    """Bearing from the previous image of the same session/sequence (plan 6.4 step 4 cross-check)."""
    out: dict[int, float | None] = {}
    groups: dict[str, list[Image]] = {}
    for im in images:
        key = im.session_id or im.sequence_id
        if key:
            groups.setdefault(key, []).append(im)
    for group in groups.values():
        group.sort(key=lambda i: (i.captured_at or datetime.min.replace(tzinfo=None)).isoformat() if i.captured_at else "")
        prev = None
        for im in group:
            if prev is not None and im.captured_at and prev.captured_at:
                gap = (im.captured_at - prev.captured_at).total_seconds()
                x0, y0 = lonlat_to_xy(prev.lon, prev.lat)
                x1, y1 = lonlat_to_xy(im.lon, im.lat)
                if 0 <= gap <= float(geo["travel_direction_max_gap_s"]) and math.hypot(x1 - x0, y1 - y0) >= float(geo["travel_direction_min_move_m"]):
                    out[im.id] = bearing_deg(x0, y0, x1, y1)
            prev = im
    return out


def geolocate_all(session: Session, pipeline_cfg: dict[str, Any] | None = None, model: str | None = None,
                  only_unassigned: bool = False) -> dict[str, Any]:
    """Locate + snap every real detection; also store the naive baseline edge in est fields for eval."""
    pipeline_cfg = pipeline_cfg or config.pipeline()
    cam_h = float(pipeline_cfg["coverage"]["camera_height_m"])
    roads = RoadIndex(session.exec(select(RoadCentreline)).all())
    edges = EdgeIndex([e for e in session.exec(select(FootpathEdge)).all()])
    images = {i.id: i for i in session.exec(select(Image)).all() if not i.synthetic}
    travel = travel_bearings(list(images.values()), pipeline_cfg["geolocation"])
    q = select(Detection).where(Detection.synthetic == False)
    if model:
        q = q.where(Detection.model == model)
    dets = session.exec(q).all()
    stats = {"detections": 0, "snapped": 0, "on_side": 0, "side_agree": 0, "side_disagree": 0, "no_image": 0,
             "no_heading": 0, "fallback_distance": 0, "naive_differs": 0}
    for d in dets:
        if only_unassigned and d.assigned_edge_id is not None:
            continue
        im = images.get(d.image_id)
        if im is None:
            stats["no_image"] += 1
            continue
        stats["detections"] += 1
        if im.heading_deg is None:
            stats["no_heading"] += 1
        w, h = d.image_w or im.width or 1, d.image_h or im.height or 1
        x, y = lonlat_to_xy(im.lon, im.lat)
        cam = Camera(x, y, im.heading_deg, im.pitch_deg, im.hfov_deg or 65.0, w, h, im.gps_accuracy_m, travel.get(im.id))
        loc, snapped = snap_detection(cam, Box(d.x1, d.y1, d.x2, d.y2), roads, edges, pipeline_cfg, cam_h)
        lon, lat = xy_to_lonlat(loc.x, loc.y)
        d.est_lat, d.est_lon, d.est_distance_m = float(lat), float(lon), loc.distance_m
        d.assigned_edge_id, d.side, d.snap_confidence = snapped.edge_id, snapped.side, snapped.confidence
        naive_edge, _ = snap_naive(Point(x, y), edges, float(pipeline_cfg["snapping"]["max_snap_distance_m"]))
        d.naive_edge_id = naive_edge.id if naive_edge else None
        d.position_along_edge_m = snapped.position_along_edge_m
        if not loc.distance_from_model:
            stats["fallback_distance"] += 1
        if snapped.edge_id is not None:
            stats["snapped"] += 1
            stats["on_side"] += int(snapped.on_side)
            if naive_edge is not None and naive_edge.id != snapped.edge_id:
                stats["naive_differs"] += 1
        if snapped.side_agreement is True:
            stats["side_agree"] += 1
        elif snapped.side_agreement is False:
            stats["side_disagree"] += 1
        session.add(d)
    session.commit()
    log.info("geolocate: %s", stats)
    return stats
