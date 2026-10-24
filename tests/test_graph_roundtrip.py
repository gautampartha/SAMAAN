"""Export -> (pretend a human edited it) -> import keeps the graph intact and validates."""
from __future__ import annotations

import json

from sqlmodel import Session, select

from api.db import get_engine, reset_db
from api.models import FootpathEdge, FootpathNode
from pipeline.graph.export import export
from pipeline.graph.import_corrected import import_corrected
from pipeline.graph.validate import validate


def test_export_import_roundtrip(db_session, toy_zone_cfg, tmp_path):
    out = tmp_path / "graph.geojson"
    n_edges, n_nodes = export(db_session, out)
    assert n_edges == len(db_session.exec(select(FootpathEdge)).all())
    assert n_nodes == len(db_session.exec(select(FootpathNode)).all())
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["features"][0]["properties"]["kind"] in ("sidewalk", "crossing", "connector")
    before = validate(db_session)

    # simulate a human edit: delete one crossing, retag one sidewalk side
    feats = data["features"]
    crossing = next(f for f in feats if f["properties"]["kind"] == "crossing")
    feats.remove(crossing)
    sw = next(f for f in feats if f["properties"]["kind"] == "sidewalk")
    sw["properties"]["side"] = "R" if sw["properties"]["side"] == "L" else "L"
    edited = tmp_path / "edited.geojson"
    edited.write_text(json.dumps(data), encoding="utf-8")

    db2 = tmp_path / "imported.sqlite"
    engine = reset_db(db2)
    with Session(engine) as s2:
        report = import_corrected(edited, s2, zone_cfg=toy_zone_cfg)
        edges2 = s2.exec(select(FootpathEdge)).all()
        assert len(edges2) == n_edges - 1
        assert report["components"] == 1 and report["ok_one_main_component"]
        assert report["edges_under_0_5m"] == 0
        # provenance: edited edges keep their original id in osm_tags
        assert all(e.osm_tags.get("import_id") is not None for e in edges2)
        retagged = next(e for e in edges2 if e.osm_tags.get("import_id") == sw["properties"]["id"])
        assert retagged.side == sw["properties"]["side"]
        assert abs(sum(e.length_m for e in edges2) - (before["total_length_km"] * 1000 - crossing["properties"]["length_m"])) < 1.0
    # restore the engine for the shared fixture DB
    get_engine(db_session.get_bind().url.database)
