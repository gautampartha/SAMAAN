"""View cones, image->edge observation, coverage counts and state recompute (plan 6.2 / 6.5)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from shapely.geometry import LineString, Point
from sqlmodel import Session, select

from api.db import reset_db
from api.models import Barrier, Coverage, FootpathEdge, FootpathNode, Image
from common import config
from common.crs import to_wgs84, xy_to_lonlat
from pipeline.coverage.compute import compute_coverage, image_sees, view_cone
from pipeline.state.recompute import recompute_states

COV = config.pipeline()["coverage"]
NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
X0, Y0 = 750_000.0, 3_170_000.0  # inside UTM 43N near Delhi


def img(x: float, y: float, heading: float | None, hfov: float = 65, acc: float = 5, **kw) -> Image:
    lon, lat = xy_to_lonlat(x, y)
    kw.setdefault("captured_at", NOW)
    return Image(source="own", lat=lat, lon=lon, heading_deg=heading, hfov_deg=hfov, gps_accuracy_m=acc,
                 synthetic=False, **kw)


def test_view_cone_shape():
    cone = view_cone(0, 0, 0, 60, 20)  # looking north
    assert cone.contains(Point(0, 10))
    assert cone.contains(Point(5, 15))        # within +-30 deg
    assert not cone.contains(Point(15, 5))    # 71 deg off axis
    assert not cone.contains(Point(0, 25))    # beyond range
    assert not cone.contains(Point(0, -5))    # behind
    disc = view_cone(0, 0, None, 360, 20)
    assert disc.contains(Point(-15, -10)) and not disc.contains(Point(0, 21))


def test_image_sees_edge_rules():
    edge = LineString([(X0, Y0), (X0 + 50, Y0)])  # east-west, sidewalk at y = Y0
    camera_y = Y0 - 8                              # 8 m south of it
    assert image_sees(img(X0 + 25, camera_y, 0), edge, COV)            # looking north at it
    assert not image_sees(img(X0 + 25, camera_y, 180), edge, COV)      # looking away
    assert not image_sees(img(X0 + 25, Y0 - 30, 0), edge, COV)         # 30 m away: too far
    assert not image_sees(img(X0 + 25, camera_y, None), edge, COV)     # no heading, perspective camera
    assert image_sees(img(X0 + 25, camera_y, None, hfov=360, camera_type="spherical"), edge, COV)
    assert not image_sees(img(X0 + 25, camera_y, 0, acc=40), edge, COV)  # GPS too poor
    # grazing: camera 14 m away looking along the edge direction still intersects within 20 m
    assert image_sees(img(X0 + 25, Y0 - 14, 0, hfov=90), edge, COV)


def _toy_db(tmp_path):
    engine = reset_db(tmp_path / "cov.sqlite")
    with Session(engine) as s:
        a = FootpathNode(lat=0, lon=0, x=X0, y=Y0)
        b = FootpathNode(lat=0, lon=0, x=X0 + 100, y=Y0)
        c = FootpathNode(lat=0, lon=0, x=X0 + 100, y=Y0 + 200)
        s.add(a); s.add(b); s.add(c); s.flush()
        e1 = LineString([(X0, Y0), (X0 + 100, Y0)])
        e2 = LineString([(X0 + 100, Y0), (X0 + 100, Y0 + 200)])
        for u, v, g, side in ((a, b, e1, "L"), (b, c, e2, "R")):
            s.add(FootpathEdge(u=u.id, v=v.id, geom_wkt=to_wgs84(g).wkt, geom_m_wkt=g.wkt, length_m=g.length,
                               side=side, kind="sidewalk", synthesized=True))
        s.commit()
    return engine


def test_compute_coverage_counts_and_threshold(tmp_path):
    engine = _toy_db(tmp_path)
    with Session(engine) as s:
        e1, e2 = s.exec(select(FootpathEdge).order_by(FootpathEdge.id)).all()
        # two good images of e1, one image of e2, one synthetic image that must be ignored
        s.add(img(X0 + 20, Y0 - 8, 0, captured_at=NOW - timedelta(days=3)))
        s.add(img(X0 + 60, Y0 - 8, 0, captured_at=NOW - timedelta(days=1)))
        s.add(img(X0 + 92, Y0 + 100, 90))
        fake = img(X0 + 92, Y0 + 150, 90); fake.synthetic = True; s.add(fake)
        s.commit()
        summary = compute_coverage(s, COV)
        assert summary["images_total"] == 3 and summary["images_usable"] == 3
        cov = {c.edge_id: c for c in s.exec(select(Coverage)).all()}
        assert cov[e1.id].observed and cov[e1.id].n_images == 2 and cov[e1.id].side == "L"
        assert cov[e1.id].last_observed_at.replace(tzinfo=UTC) == NOW - timedelta(days=1)
        assert not cov[e2.id].observed and cov[e2.id].n_images == 1
        assert all(c.source == "image" and not c.synthetic for c in cov.values())
        # recompute is idempotent (old image rows replaced, not duplicated)
        compute_coverage(s, COV)
        assert len(s.exec(select(Coverage)).all()) == 2


def test_recompute_prefers_real_coverage_over_seed(tmp_path):
    engine = _toy_db(tmp_path)
    with Session(engine) as s:
        e1, e2 = s.exec(select(FootpathEdge).order_by(FootpathEdge.id)).all()
        s.add(Coverage(edge_id=e1.id, side="L", observed=True, n_images=3, last_observed_at=NOW, source="seed", synthetic=True))
        s.add(Coverage(edge_id=e2.id, side="R", observed=True, n_images=3, last_observed_at=NOW, source="seed", synthetic=True))
        s.add(Coverage(edge_id=e2.id, side="R", observed=False, n_images=1, last_observed_at=None, source="image", synthetic=False))
        s.commit()
        counts = recompute_states(s, now=NOW)
        e1, e2 = s.exec(select(FootpathEdge).order_by(FootpathEdge.id)).all()
        assert e1.state == "clear" and e1.state_synthetic is True and e1.observed_by == "image"
        assert e2.state == "unknown" and e2.state_synthetic is False  # real (insufficient) coverage wins
        assert counts["from_real_coverage"] == 1 and counts["from_seed_coverage"] == 1
        # a real blocking barrier flips e1 to blocked and keeps it non-synthetic
        s.add(Barrier(class_id="steps_or_high_kerb", severity=5, edge_id=e1.id, lat=0, lon=0, synthetic=False))
        s.add(Coverage(edge_id=e1.id, side="L", observed=True, n_images=2, last_observed_at=NOW, source="image", synthetic=False))
        s.commit()
        recompute_states(s, now=NOW)
        e1 = s.get(FootpathEdge, e1.id)
        assert e1.state == "blocked" and e1.state_synthetic is False


def test_stale_real_coverage_is_unknown(tmp_path):
    engine = _toy_db(tmp_path)
    with Session(engine) as s:
        e1 = s.exec(select(FootpathEdge)).first()
        s.add(Coverage(edge_id=e1.id, side="L", observed=True, n_images=2, last_observed_at=NOW - timedelta(days=400),
                       source="image", synthetic=False))
        s.commit()
        recompute_states(s, now=NOW)
        assert s.get(FootpathEdge, e1.id).state == "unknown"
