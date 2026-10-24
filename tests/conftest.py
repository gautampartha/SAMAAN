"""Offline fixtures: a toy road grid in EPSG:32643 around the zone centre, run through footpath
synthesis (P1) and seeded with the same code path as `make seed`. No network access in tests."""
from __future__ import annotations

import copy
import os
from datetime import UTC, datetime
from pathlib import Path

import networkx as nx
import pytest
from sqlmodel import Session

from common import config
from common.crs import METRIC, lonlat_to_xy, xy_to_lonlat

GRID_N = 5
SPACING_M = 100.0
NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)


def toy_grid_graph() -> nx.MultiDiGraph:
    """5x5 grid, 100 m spacing, bidirectional residential edges, centred on the zone centre."""
    z = config.zone()["center"]
    cx, cy = lonlat_to_xy(z["lon"], z["lat"])
    G = nx.MultiDiGraph(crs=METRIC)
    for i in range(GRID_N):
        for j in range(GRID_N):
            G.add_node(i * GRID_N + j, x=cx + i * SPACING_M, y=cy + j * SPACING_M)
    for i in range(GRID_N):
        for j in range(GRID_N):
            n = i * GRID_N + j
            if i + 1 < GRID_N:
                m = (i + 1) * GRID_N + j
                G.add_edge(n, m, length=SPACING_M, highway="residential", osmid=1000 + n)
                G.add_edge(m, n, length=SPACING_M, highway="residential", osmid=1000 + n)
            if j + 1 < GRID_N:
                m = i * GRID_N + j + 1
                G.add_edge(n, m, length=SPACING_M, highway="residential", osmid=2000 + n)
                G.add_edge(m, n, length=SPACING_M, highway="residential", osmid=2000 + n)
    return G


@pytest.fixture(scope="session")
def toy_zone_cfg() -> dict:
    cfg = copy.deepcopy(config.zone())
    G = toy_grid_graph()
    lon, lat = xy_to_lonlat(G.nodes[0]["x"], G.nodes[0]["y"])
    cfg["anchors"] = [{"id": "metro_karkarduma", "kind": "metro", "name": {"en": "Toy metro", "hi": "टॉय मेट्रो"},
                       "lat": lat, "lon": lon, "source": "test", "verified": False}]
    cfg["anchor_discovery"] = {"enabled": False}
    cfg["demo"]["riya"]["origin_anchor"] = cfg["anchors"][0]["id"]  # the toy anchor, whatever the real zone uses
    cfg["demo"]["riya"]["target_network_distance_m"] = 300
    cfg["demo"]["riya"]["target_tolerance_m"] = 50
    return cfg


@pytest.fixture(scope="session")
def toy_pipeline_cfg() -> dict:
    cfg = copy.deepcopy(config.pipeline())
    cfg["seed"]["n_random_barriers"] = 10
    cfg["seed"]["observed_edge_fraction"] = 0.5
    return cfg


@pytest.fixture(scope="session")
def toy_db(tmp_path_factory, toy_zone_cfg, toy_pipeline_cfg) -> Path:
    """Build + seed a toy DB once per test session. Sets SAMAAN_DB for the API."""
    import osmnx as ox

    from api.db import reset_db
    from pipeline.graph.osm import write_anchors, write_graph, write_meta
    from pipeline.graph.synthesize import synthesize
    from pipeline.seed.synthetic import seed

    path = tmp_path_factory.mktemp("db") / "toy.sqlite"
    os.environ["SAMAAN_DB"] = str(path)
    engine = reset_db(path)
    G = ox.convert.to_undirected(toy_grid_graph())
    F, _ = synthesize(G, [], config.pipeline()["footpath_synthesis"])
    with Session(engine) as session:
        write_graph(F, session, synthetic=True)
        write_anchors(toy_zone_cfg["anchors"], session)
        write_meta(session, osm_attribution="toy graph (test)")
        seed(session, zone_cfg=toy_zone_cfg, pipeline_cfg=toy_pipeline_cfg, now=NOW)
    return path


@pytest.fixture()
def db_session(toy_db) -> Session:
    from api.db import get_engine

    with Session(get_engine(toy_db)) as s:
        yield s
