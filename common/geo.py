"""Small geometry helpers used by snapping and seeding. All inputs are in EPSG:32643."""
from __future__ import annotations

import math

from shapely.geometry import LineString, Point

Side = str  # "L" | "R"


def side_of_line(line: LineString, point: Point, window_m: float = 0.5) -> Side:
    """Which side of a directed line a point lies on, relative to the line's travel
    direction: 'L' for left, 'R' for right (plan 6.4 step 4).

    Uses the sign of the 2D cross product of the local line direction (taken over a
    short window around the projection of the point) and the vector to the point.
    Points exactly on the line are reported as 'R' (arbitrary but deterministic).
    """
    length = line.length
    if length == 0:
        raise ValueError("side_of_line needs a line with non-zero length")
    d = line.project(point)
    a = line.interpolate(max(d - window_m, 0.0))
    b = line.interpolate(min(d + window_m, length))
    dx, dy = b.x - a.x, b.y - a.y
    vx, vy = point.x - a.x, point.y - a.y
    cross = dx * vy - dy * vx
    return "L" if cross > 0 else "R"


def bearing_deg(x0: float, y0: float, x1: float, y1: float) -> float:
    """Compass bearing in degrees (0 = north, 90 = east) from (x0,y0) to (x1,y1)."""
    return (math.degrees(math.atan2(x1 - x0, y1 - y0)) + 360.0) % 360.0


def point_at_bearing(x: float, y: float, bearing: float, distance_m: float) -> tuple[float, float]:
    """Offset a metric point by distance along a compass bearing."""
    r = math.radians(bearing)
    return x + distance_m * math.sin(r), y + distance_m * math.cos(r)


def point_along(line: LineString, distance_m: float) -> Point:
    """Point at a clamped distance along a line."""
    return line.interpolate(min(max(distance_m, 0.0), line.length))
