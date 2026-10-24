"""Export the footpath graph to GeoJSON (WGS84) for correction in QGIS / JOSM.

    python -m pipeline.graph.export [--out data/processed/footpath_graph.geojson]

Edit geometry/kind/side freely; keep `id` on edges you edited so provenance survives; delete
edges you don't want; add new LineStrings for missing footpaths (no `id` needed). Re-import with
`python -m pipeline.graph.import_corrected FILE`.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from sqlmodel import Session, select

from api.db import init_db
from api.geojson import feature, point_feature
from api.models import FootpathEdge, FootpathNode
from common.paths import PROCESSED_DIR

EDGE_PROPS = ("kind", "side", "parent_road_osm_id", "highway", "synthesized", "signal", "kerb_ramp_start",
              "kerb_ramp_end", "width_m")


def export(session: Session, out: Path) -> tuple[int, int]:
    edges = session.exec(select(FootpathEdge)).all()
    nodes = session.exec(select(FootpathNode)).all()
    efeats = []
    for e in edges:
        props = {"id": e.id, **{k: getattr(e, k) for k in EDGE_PROPS},
                 "length_m": round(e.length_m, 2), "osm_tags": json.dumps(e.osm_tags, ensure_ascii=False)}
        efeats.append(feature(e.geom_wkt, props, fid=e.id))
    nfeats = [point_feature(n.lon, n.lat, {"id": n.id, "kind": n.kind, "osm_id": n.osm_id}, fid=n.id) for n in nodes]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "name": "footpath_edges",
                               "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
                               "features": efeats}, ensure_ascii=False), encoding="utf-8")
    nodes_out = out.with_name(out.stem + "_nodes.geojson")
    nodes_out.write_text(json.dumps({"type": "FeatureCollection", "name": "footpath_nodes", "features": nfeats},
                                    ensure_ascii=False), encoding="utf-8")
    return len(efeats), len(nfeats)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=PROCESSED_DIR / "footpath_graph.geojson")
    args = ap.parse_args()
    with Session(init_db()) as session:
        ne, nn = export(session, args.out)
    print(f"exported {ne} edges -> {args.out} and {nn} nodes -> {args.out.with_name(args.out.stem + '_nodes.geojson')}")


if __name__ == "__main__":
    main()
