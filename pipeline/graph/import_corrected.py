"""Import a human-corrected footpath GeoJSON (from export.py, edited in QGIS/JOSM) as the graph.

    python -m pipeline.graph.import_corrected data/corrected/footpath_graph_corrected.geojson

Rebuilds nodes by merging LineString endpoints closer than `node_merge_tolerance_m`, resets the
DB graph tables, re-snaps anchors, writes provenance to Meta and prints the validation report.
Run `make seed` afterwards to put the synthetic overlay back (until real data exists).
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Any

import networkx as nx
from shapely.geometry import LineString, Point, shape
from sqlmodel import Session

from api.db import reset_db
from common import config
from common.crs import METRIC, to_metric
from common.paths import ROOT
from pipeline.graph.osm import (
    extract_places,
    write_graph,
    write_meta,
    write_places,
    write_zone_anchors,
)
from pipeline.graph.validate import to_markdown, validate

log = logging.getLogger(__name__)
BOOL_PROPS = ("synthesized", "signal", "kerb_ramp_start", "kerb_ramp_end")


def _bool(v: Any) -> bool | None:
    if v in (None, "", "null"):
        return None
    if isinstance(v, bool):
        return v
    return str(v).lower() in ("1", "true", "yes", "t")


def graph_from_geojson(path: Path, tolerance_m: float) -> nx.MultiGraph:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    F = nx.MultiGraph(crs=METRIC)
    cells: dict[tuple[int, int], list[tuple[int, Point]]] = {}

    def node_for(pt: Point) -> int:
        cx, cy = int(pt.x // tolerance_m), int(pt.y // tolerance_m)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for nid, p in cells.get((cx + dx, cy + dy), []):
                    if p.distance(pt) <= tolerance_m:
                        return nid
        nid = F.number_of_nodes() + 1
        F.add_node(nid, x=float(pt.x), y=float(pt.y), kind="junction", osm_id=None)
        cells.setdefault((cx, cy), []).append((nid, pt))
        return nid

    skipped = 0
    for f in data.get("features", []):
        geom = f.get("geometry")
        if not geom or geom.get("type") != "LineString":
            skipped += 1
            continue
        line = to_metric(shape(geom))
        if not isinstance(line, LineString) or line.length <= 0:
            skipped += 1
            continue
        props = f.get("properties") or {}
        tags = props.get("osm_tags") or {}
        if isinstance(tags, str):
            try:
                tags = json.loads(tags)
            except json.JSONDecodeError:
                tags = {}
        if props.get("id") is not None:
            tags["import_id"] = props["id"]
        a = node_for(Point(line.coords[0]))
        b = node_for(Point(line.coords[-1]))
        parent = props.get("parent_road_osm_id")
        F.add_edge(a, b, kind=props.get("kind") or "footway", side=props.get("side") or "none", geometry=line,
                   length=float(line.length), parent_road_osm_id=int(parent) if parent not in (None, "") else None,
                   osm_tags=tags, highway=props.get("highway") or tags.get("highway"),
                   synthesized=bool(_bool(props.get("synthesized"))), signal=_bool(props.get("signal")),
                   kerb_ramp_start=_bool(props.get("kerb_ramp_start")), kerb_ramp_end=_bool(props.get("kerb_ramp_end")))
    for a, b, d in F.edges(data=True):
        if d["kind"] == "crossing":
            F.nodes[a]["kind"] = F.nodes[b]["kind"] = "crossing_end"
    if skipped:
        log.warning("skipped %d non-LineString / empty features", skipped)
    return F


def import_corrected(path: Path, session: Session, zone_cfg: dict[str, Any] | None = None,
                     tolerance_m: float | None = None) -> dict[str, Any]:
    zone_cfg = zone_cfg or config.zone()
    tol = tolerance_m if tolerance_m is not None else float(config.pipeline()["footpath_synthesis"]["node_merge_tolerance_m"])
    F = graph_from_geojson(path, tol)
    write_graph(F, session, synthetic=False)
    xml = ROOT / zone_cfg["osm"]["raw_cache"]
    write_zone_anchors(xml if xml.exists() else None, zone_cfg, session)
    if xml.exists():
        write_places(extract_places(xml, zone_cfg), session)
    write_meta(session, graph_source=f"human-corrected GeoJSON {path}", osm_attribution=zone_cfg["osm"]["attribution"],
               crs_metric=METRIC)
    return validate(session)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file", type=Path)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    engine = reset_db()
    with Session(engine) as session:
        r = import_corrected(args.file, session)
    print(to_markdown(r))


if __name__ == "__main__":
    main()
