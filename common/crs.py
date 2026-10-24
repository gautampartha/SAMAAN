"""All metric geometry lives in EPSG:32643 (UTM 43N). These helpers are the only place
that converts between WGS84 and metric coordinates."""
from __future__ import annotations

from functools import lru_cache

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry.base import BaseGeometry

WGS84 = "EPSG:4326"
METRIC = "EPSG:32643"


@lru_cache(maxsize=4)
def _transformer(src: str, dst: str) -> Transformer:
    return Transformer.from_crs(src, dst, always_xy=True)


def _apply(geom: BaseGeometry, t: Transformer) -> BaseGeometry:
    def f(coords: np.ndarray) -> np.ndarray:
        x, y = t.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([x, y])

    return shapely.transform(geom, f)


def to_metric(geom: BaseGeometry) -> BaseGeometry:
    """WGS84 (lon, lat) -> EPSG:32643 (x, y) in metres."""
    return _apply(geom, _transformer(WGS84, METRIC))


def to_wgs84(geom: BaseGeometry) -> BaseGeometry:
    """EPSG:32643 (x, y) -> WGS84 (lon, lat)."""
    return _apply(geom, _transformer(METRIC, WGS84))


def lonlat_to_xy(lon: float, lat: float) -> tuple[float, float]:
    x, y = _transformer(WGS84, METRIC).transform(lon, lat)
    return float(x), float(y)


def xy_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon, lat = _transformer(METRIC, WGS84).transform(x, y)
    return float(lon), float(lat)
