"""Plan 6.4: bearing, ground-plane distance, side of road, side-aware snapping vs naive, clustering."""
from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest
from shapely.geometry import LineString, Point
from sqlmodel import Session, select

from api.db import reset_db
from api.models import Barrier, Detection, FootpathEdge, FootpathNode, Image, RoadCentreline
from common import config
from common.crs import to_wgs84, xy_to_lonlat
from pipeline.geolocate.barriers import build_barriers, cluster_1d, cluster_confidence, time_profile
from pipeline.geolocate.geolocate import (
    Box,
    Camera,
    EdgeIndex,
    RoadIndex,
    bearing_to_object,
    geolocate_all,
    ground_distance,
    locate,
    road_side,
    snap_detection,
    snap_naive,
    vfov_deg,
)

PIPE = config.pipeline()
GEO = PIPE["geolocation"]
X0, Y0 = 750_000.0, 3_170_000.0
NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)


def cam(x=X0, y=Y0, heading=0.0, pitch=0.0, hfov=60.0, w=1000, h=1000, acc=5.0, travel=None):
    return Camera(x, y, heading, pitch, hfov, w, h, acc, travel)


def test_bearing_from_box_centre():
    c = cam(heading=90.0, hfov=60.0)
    assert bearing_to_object(c, Box(450, 0, 550, 10)) == pytest.approx(90.0)      # centred -> heading
    assert bearing_to_object(c, Box(0, 0, 0, 10)) == pytest.approx(60.0)          # left edge -> -HFOV/2
    assert bearing_to_object(c, Box(1000, 0, 1000, 10)) == pytest.approx(120.0)   # right edge -> +HFOV/2
    assert bearing_to_object(cam(heading=350.0, hfov=60.0), Box(1000, 0, 1000, 10)) == pytest.approx(20.0)  # wraps


def test_vfov_and_ground_distance():
    assert vfov_deg(90.0, 1000, 1000) == pytest.approx(90.0)
    assert vfov_deg(90.0, 2000, 1000) == pytest.approx(53.13, abs=0.01)
    c = cam(hfov=90.0)  # VFOV 90: box bottom at 75% height -> 22.5 deg below horizon
    d, from_model = ground_distance(c, Box(0, 0, 10, 750), GEO, 1.3)
    assert from_model and d == pytest.approx(1.3 / math.tan(math.radians(22.5)), rel=1e-6)
    # on the horizon -> fallback; very low in the frame -> clamped to min
    assert ground_distance(c, Box(0, 0, 10, 500), GEO, 1.3) == (GEO["distance_fallback_m"], False)
    assert ground_distance(c, Box(0, 0, 10, 1000), GEO, 1.3)[0] == pytest.approx(1.3)  # 45 deg down -> h/tan(45) = h
    assert ground_distance(c, Box(0, 0, 10, 1000), GEO, 0.5)[0] == GEO["distance_min_m"]  # clamp
    # tilting the phone down (negative pitch) moves the horizon up -> objects look further below -> nearer
    d_flat = ground_distance(c, Box(0, 0, 10, 600), GEO, 1.3)[0]
    d_down = ground_distance(cam(hfov=90.0, pitch=-10.0), Box(0, 0, 10, 600), GEO, 1.3)[0]
    assert d_down < d_flat


def test_locate_offsets_along_bearing_and_image_side():
    c = cam(heading=0.0, hfov=90.0)
    loc = locate(c, Box(900, 0, 1000, 750), GEO, 1.3)  # right side of the frame, looking north
    assert loc.bearing_deg == pytest.approx(40.5)
    assert loc.x > X0 and loc.y > Y0 and loc.image_side == "R"
    left = locate(c, Box(0, 0, 100, 750), GEO, 1.3)
    assert left.x < X0 and left.image_side == "L"


def test_road_side_convention_and_travel_flip():
    road = LineString([(0, 0), (100, 0)])  # stored direction east; L = north
    assert road_side(Point(50, 5), road, travel_bearing=90.0) == ("L", "L")     # walking east: north is left
    assert road_side(Point(50, 5), road, travel_bearing=270.0) == ("L", "R")    # walking west: north is right
    assert road_side(Point(50, -5), road, None) == ("R", None)


def _toy_db(tmp_path):
    """One east-west road with L (north) and R (south) sidewalks 4.5 m away, plus a crossing."""
    engine = reset_db(tmp_path / "geo.sqlite")
    with Session(engine) as s:
        road = LineString([(X0, Y0), (X0 + 200, Y0)])
        s.add(RoadCentreline(osm_id=777, highway="residential", geom_wkt=to_wgs84(road).wkt, geom_m_wkt=road.wkt,
                             length_m=200.0, half_width_m=3.5, has_sidewalks=True))
        nodes = []
        for x, y in [(X0, Y0 + 4.5), (X0 + 200, Y0 + 4.5), (X0, Y0 - 4.5), (X0 + 200, Y0 - 4.5)]:
            n = FootpathNode(lat=0, lon=0, x=x, y=y)
            s.add(n); nodes.append(n)
        s.flush()
        left = LineString([(X0, Y0 + 4.5), (X0 + 200, Y0 + 4.5)])
        right = LineString([(X0, Y0 - 4.5), (X0 + 200, Y0 - 4.5)])
        s.add(FootpathEdge(u=nodes[0].id, v=nodes[1].id, geom_wkt=to_wgs84(left).wkt, geom_m_wkt=left.wkt, length_m=200,
                           side="L", kind="sidewalk", parent_road_osm_id=777, synthesized=True))
        s.add(FootpathEdge(u=nodes[2].id, v=nodes[3].id, geom_wkt=to_wgs84(right).wkt, geom_m_wkt=right.wkt, length_m=200,
                           side="R", kind="sidewalk", parent_road_osm_id=777, synthesized=True))
        s.commit()
    return engine


def test_side_aware_snap_beats_naive(tmp_path):
    engine = _toy_db(tmp_path)
    with Session(engine) as s:
        roads = RoadIndex(s.exec(select(RoadCentreline)).all())
        edges = EdgeIndex(s.exec(select(FootpathEdge)).all())
        left_edge = next(e for e in edges.edges if e.side == "L")
        right_edge = next(e for e in edges.edges if e.side == "R")
        # Camera stands on the LEFT (north) sidewalk, walking east, and photographs a barrier on the
        # RIGHT (south) sidewalk across the road: box low in the frame, right of centre.
        c = cam(x=X0 + 100, y=Y0 + 4.5, heading=90.0 + 60.0, hfov=90.0, acc=4.0, travel=90.0)
        _loc, snapped = snap_detection(c, Box(500, 0, 600, 590), roads, edges, PIPE, 1.3)
        assert snapped.edge_id == right_edge.id and snapped.side == "R" and snapped.on_side
        assert snapped.side_agreement is True and snapped.confidence > 0.8
        assert 0 <= snapped.position_along_edge_m <= 200
        naive_edge, _ = snap_naive(Point(c.x, c.y), edges, 12.0)
        assert naive_edge.id == left_edge.id  # the baseline snaps to where the camera stands: wrong side
        # a barrier right at the walker's feet on the left sidewalk, slightly left of centre
        c2 = cam(x=X0 + 100, y=Y0 + 4.5, heading=90.0, hfov=90.0, acc=4.0, travel=90.0)
        _, s2 = snap_detection(c2, Box(380, 0, 480, 900), roads, edges, PIPE, 1.3)
        assert s2.edge_id == left_edge.id and s2.side == "L"


def test_side_disagreement_lowers_confidence(tmp_path):
    """Image side (box left/right of travel) and road side (located point vs centreline) disagree
    when GPS puts the camera on the wrong side: a near object seen slightly LEFT while the camera
    position says it is still on the right-hand sidewalk."""
    engine = _toy_db(tmp_path)
    with Session(engine) as s:
        roads = RoadIndex(s.exec(select(RoadCentreline)).all())
        edges = EdgeIndex(s.exec(select(FootpathEdge)).all())
        c = cam(x=X0 + 100, y=Y0 - 4.5, heading=90.0, hfov=90.0, acc=4.0, travel=90.0)
        _, bad = snap_detection(c, Box(380, 0, 480, 760), roads, edges, PIPE, 1.3)   # 3 m away, left of centre
        _, ok = snap_detection(c, Box(520, 0, 620, 760), roads, edges, PIPE, 1.3)    # 3 m away, right of centre
        assert bad.side_agreement is False and ok.side_agreement is True
        assert bad.side == "R" and ok.side == "R"
        assert bad.confidence < ok.confidence


def test_cluster_1d_and_confidence_and_profile():
    assert cluster_1d([(1, 0.0), (2, 3.0), (3, 9.0), (4, 12.5), (5, 30.0)], 4.0) == [[1, 2], [3, 4], [5]]
    assert cluster_1d([], 4.0) == []
    b = PIPE["barriers"]
    assert cluster_confidence([0.6], b) == pytest.approx(0.6)
    assert cluster_confidence([0.6, 0.5, 0.7], b) > cluster_confidence([0.7], b)
    assert cluster_confidence([0.95] * 10, b) == b["max_confidence"]
    assert time_profile([NOW], 3) == [0.5] * 24
    prof = time_profile([NOW.replace(hour=11), NOW.replace(hour=12), NOW.replace(hour=12), NOW.replace(hour=13)], 3)
    assert prof[12] == 1.0 and prof[3] == 0.1 and len(prof) == 24


def test_geolocate_all_and_build_barriers(tmp_path):
    engine = _toy_db(tmp_path)
    with Session(engine) as s:
        right_edge = next(e for e in s.exec(select(FootpathEdge)).all() if e.side == "R")
        lon, lat = xy_to_lonlat(X0 + 100, Y0 + 4.5)
        imgs = []
        for i in range(3):
            im = Image(source="own", lat=lat, lon=lon, heading_deg=150.0, pitch_deg=0.0, hfov_deg=90.0, width=1000, height=1000,
                       gps_accuracy_m=4.0, captured_at=NOW + timedelta(seconds=10 * i), session_id="walk-L", synthetic=False)
            s.add(im); imgs.append(im)
        fake = Image(source="own", lat=lat, lon=lon, heading_deg=150.0, hfov_deg=90.0, width=1000, height=1000, synthetic=True)
        s.add(fake)
        s.flush()
        for im in imgs:  # same barrier seen 3 times (steps across the road) + a two-wheeler
            s.add(Detection(image_id=im.id, class_id="steps_or_high_kerb", score=0.8, x1=500, y1=0, x2=600, y2=590,
                            model="t", image_w=1000, image_h=1000, synthetic=False))
        s.add(Detection(image_id=imgs[0].id, class_id="parked_vehicle", score=0.7, x1=500, y1=0, x2=600, y2=590,
                        model="t", image_w=1000, image_h=1000, synthetic=False))
        s.add(Detection(image_id=fake.id, class_id="open_drain", score=0.9, x1=500, y1=0, x2=600, y2=590, synthetic=True))
        s.commit()
        stats = geolocate_all(s, PIPE)
        assert stats["detections"] == 4 and stats["snapped"] == 4 and stats["on_side"] == 4
        d = s.exec(select(Detection).where(Detection.class_id == "steps_or_high_kerb")).first()
        assert d.assigned_edge_id == right_edge.id and d.naive_edge_id != right_edge.id and d.est_lat is not None
        bstats = build_barriers(s, PIPE, now=NOW)
        barriers = s.exec(select(Barrier)).all()
        assert bstats["barriers_created"] == 2 and len(barriers) == 2
        steps = next(b for b in barriers if b.class_id == "steps_or_high_kerb")
        assert len(steps.sources) == 3 and steps.edge_id == right_edge.id and steps.side == "R"
        assert steps.severity == PIPE["barriers"]["default_severity"]["steps_or_high_kerb"] and steps.permanent
        assert steps.confidence > 0.8 and not steps.synthetic and steps.time_profile is None
        bike = next(b for b in barriers if b.class_id == "parked_vehicle")
        assert not bike.permanent and bike.time_profile == [0.5] * 24
        # rebuild is idempotent and leaves report barriers alone
        s.add(Barrier(class_id="waterlogging", severity=3, edge_id=right_edge.id, lat=0, lon=0, sources=["report:1"], synthetic=False))
        s.commit()
        build_barriers(s, PIPE, now=NOW)
        kinds = sorted(b.class_id for b in s.exec(select(Barrier)).all())
        assert kinds == ["parked_vehicle", "steps_or_high_kerb", "waterlogging"]
