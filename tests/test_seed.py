from shapely import wkt
from sqlmodel import select

from api.models import Anchor, Barrier, Coverage, DemoRoute, FootpathEdge, Meta
from common import config
from common.state import compute_edge_state
from tests.conftest import GRID_N, NOW


def test_toy_graph_written(db_session):
    edges = db_session.exec(select(FootpathEdge)).all()
    # 5x5 road grid -> synthesised sidewalks (2 per road segment) + crossings + corners
    n_roads = 2 * (GRID_N - 1) * GRID_N
    kinds = {e.kind for e in edges}
    assert kinds <= {"sidewalk", "crossing", "connector"}
    assert sum(1 for e in edges if e.kind == "sidewalk" and not e.osm_tags.get("corner")) == 2 * n_roads
    assert all(e.synthesized for e in edges)
    for e in edges:
        g = wkt.loads(e.geom_m_wkt)
        assert e.length_m > 0 and abs(g.length - e.length_m) < 1e-6
        assert e.side in ("L", "R", "none")


def test_everything_seeded_is_flagged_synthetic(db_session):
    assert all(b.synthetic for b in db_session.exec(select(Barrier)).all())
    assert all(c.synthetic for c in db_session.exec(select(Coverage)).all())
    assert all(r.synthetic for r in db_session.exec(select(DemoRoute)).all())
    assert all(e.state_synthetic for e in db_session.exec(select(FootpathEdge)).all())
    meta = {m.key: m.value for m in db_session.exec(select(Meta)).all()}
    assert meta["synthetic"] == "true"


def test_barriers_sit_on_existing_edges_within_length(db_session):
    edges = {e.id: e for e in db_session.exec(select(FootpathEdge)).all()}
    barriers = db_session.exec(select(Barrier)).all()
    assert len(barriers) == 3 + 10
    for b in barriers:
        e = edges[b.edge_id]
        assert 0 <= b.position_along_edge_m <= e.length_m + 1e-6
        pt_on_edge = wkt.loads(e.geom_m_wkt).interpolate(b.position_along_edge_m)
        from common.crs import lonlat_to_xy
        x, y = lonlat_to_xy(b.lon, b.lat)
        assert ((pt_on_edge.x - x) ** 2 + (pt_on_edge.y - y) ** 2) ** 0.5 < 0.5
        assert 1 <= b.severity <= 5
        assert b.permanent == (b.class_id not in config.temporary_classes())
        assert (b.time_profile is None) == b.permanent
        if b.time_profile is not None:
            assert len(b.time_profile) == 24 and all(0 <= p <= 1 for p in b.time_profile)


def test_demo_route_matches_story(db_session):
    route = db_session.get(DemoRoute, "riya")
    assert route is not None
    assert 250 <= route.length_m <= 350  # toy target 300 +/- 50
    anchor = db_session.get(Anchor, "metro_karkarduma")
    assert route.origin_node_id == anchor.node_id
    demo_barriers = [b for b in db_session.exec(select(Barrier)).all() if "seed:riya_demo" in b.sources]
    assert [b.class_id for b in demo_barriers] == ["steps_or_high_kerb", "steps_or_high_kerb", "parked_vehicle"]
    # Every demo barrier lies on the demo path geometry.
    path_m = wkt.loads(route.path_wkt)
    from common.crs import to_metric
    path_m = to_metric(path_m)
    for b in demo_barriers:
        from shapely.geometry import Point

        from common.crs import lonlat_to_xy
        assert path_m.distance(Point(*lonlat_to_xy(b.lon, b.lat))) < 0.5


def test_one_coverage_row_per_edge_and_states_consistent(db_session):
    edges = db_session.exec(select(FootpathEdge)).all()
    cov = {c.edge_id: c for c in db_session.exec(select(Coverage)).all()}
    assert set(cov) == {e.id for e in edges}
    by_edge = {}
    for b in db_session.exec(select(Barrier)).all():
        by_edge.setdefault(b.edge_id, []).append({"class": b.class_id, "severity": b.severity, "status": b.status})
    staleness = config.pipeline()["state"]["staleness_days_permanent"]
    for e in edges:
        expected, _ = compute_edge_state(by_edge.get(e.id, []), cov[e.id].observed, cov[e.id].last_observed_at,
                                         config.profiles(), staleness, NOW)
        assert e.state == expected, e.id
        if e.id in by_edge:
            assert cov[e.id].observed  # an edge with a barrier was by definition seen


def test_demo_steps_block_and_bikes_only_penalise(db_session):
    edges = {e.id: e for e in db_session.exec(select(FootpathEdge)).all()}
    for b in db_session.exec(select(Barrier)).all():
        if "seed:riya_demo" not in b.sources:
            continue
        if b.class_id == "steps_or_high_kerb":
            assert edges[b.edge_id].state == "blocked"
        elif b.class_id == "parked_vehicle":
            assert edges[b.edge_id].state == "clear"


def test_seed_is_idempotent(db_session, toy_zone_cfg, toy_pipeline_cfg):
    from pipeline.seed.synthetic import seed

    before = sorted((b.class_id, b.edge_id, round(b.position_along_edge_m, 3))
                    for b in db_session.exec(select(Barrier)).all())
    seed(db_session, zone_cfg=toy_zone_cfg, pipeline_cfg=toy_pipeline_cfg, now=NOW)
    after = sorted((b.class_id, b.edge_id, round(b.position_along_edge_m, 3))
                   for b in db_session.exec(select(Barrier)).all())
    assert before == after
    assert len(db_session.exec(select(Coverage)).all()) == len(db_session.exec(select(FootpathEdge)).all())
