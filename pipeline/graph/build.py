"""`make graph`: download OSM for the zone and write the P0 footpath graph to SQLite."""
from __future__ import annotations

import argparse
import logging

from sqlmodel import Session, func, select

from api.db import reset_db
from api.models import Anchor, FootpathEdge, FootpathNode
from common import config
from pipeline.graph.osm import build_zone_graph


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force-download", action="store_true", help="ignore the cached OSM XML")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    engine = reset_db()
    with Session(engine) as session:
        build_zone_graph(config.zone(), session, force_download=args.force_download)
        n_nodes = session.exec(select(func.count(FootpathNode.id))).one()
        n_edges = session.exec(select(func.count(FootpathEdge.id))).one()
        km = session.exec(select(func.sum(FootpathEdge.length_m))).one() or 0.0
        anchors = session.exec(select(Anchor)).all()
    print(f"graph: {n_nodes} nodes, {n_edges} edges, {km/1000:.2f} km of walkable OSM ways")
    print(f"anchors: {len(anchors)} ({', '.join(a.id for a in anchors)})")


if __name__ == "__main__":
    main()
