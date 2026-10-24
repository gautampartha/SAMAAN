import math

from shapely.geometry import LineString, Point

from common import config
from common.crs import lonlat_to_xy, to_metric, to_wgs84, xy_to_lonlat


def test_round_trip_centre():
    c = config.zone()["center"]
    x, y = lonlat_to_xy(c["lon"], c["lat"])
    lon, lat = xy_to_lonlat(x, y)
    assert abs(lon - c["lon"]) < 1e-7 and abs(lat - c["lat"]) < 1e-7
    assert 100_000 < x < 900_000  # inside a UTM zone's easting range
    assert 3_100_000 < y < 3_200_000  # ~28.65 N northing


def test_one_degree_longitude_is_about_97_7_m_per_milli_degree():
    lat = config.zone()["center"]["lat"]
    a = to_metric(Point(77.3050, lat))
    b = to_metric(Point(77.3060, lat))
    expected = 111_320 * math.cos(math.radians(lat)) * 0.001
    assert abs(a.distance(b) - expected) / expected < 0.01


def test_line_length_in_metres():
    line = LineString([(77.3000, 28.6450), (77.3000, 28.6540)])  # 0.009 deg north ~ 997 m
    m = to_metric(line)
    assert 990 < m.length < 1005
    back = to_wgs84(m)
    assert abs(back.coords[0][0] - 77.3000) < 1e-7
