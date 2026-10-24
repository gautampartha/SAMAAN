from __future__ import annotations

from typing import Any

from shapely import wkt
from shapely.geometry import mapping


def feature(geom_wkt: str, properties: dict[str, Any], fid: Any = None) -> dict[str, Any]:
    f: dict[str, Any] = {"type": "Feature", "geometry": mapping(wkt.loads(geom_wkt)), "properties": properties}
    if fid is not None:
        f["id"] = fid
    return f


def point_feature(lon: float, lat: float, properties: dict[str, Any], fid: Any = None) -> dict[str, Any]:
    f: dict[str, Any] = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                         "properties": properties}
    if fid is not None:
        f["id"] = fid
    return f


def collection(features: list[dict[str, Any]], attribution: dict[str, str], synthetic: bool) -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": features, "attribution": attribution,
            "synthetic": synthetic, "count": len(features)}
