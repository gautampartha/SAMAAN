from shapely.geometry import LineString, Point

from common.geo import bearing_deg, point_along, point_at_bearing, side_of_line


def test_side_of_horizontal_line():
    line = LineString([(0, 0), (100, 0)])  # travelling east
    assert side_of_line(line, Point(50, 10)) == "L"   # north of an eastbound line is left
    assert side_of_line(line, Point(50, -10)) == "R"


def test_side_flips_with_direction():
    line = LineString([(100, 0), (0, 0)])  # travelling west
    assert side_of_line(line, Point(50, 10)) == "R"
    assert side_of_line(line, Point(50, -10)) == "L"


def test_side_on_bent_line_uses_local_direction():
    line = LineString([(0, 0), (100, 0), (100, 100)])  # east then north
    assert side_of_line(line, Point(110, 50)) == "R"  # east of the northbound leg is right
    assert side_of_line(line, Point(90, 50)) == "L"
    assert side_of_line(line, Point(50, 5)) == "L"


def test_bearing_and_offset():
    assert bearing_deg(0, 0, 0, 10) == 0.0
    assert bearing_deg(0, 0, 10, 0) == 90.0
    assert bearing_deg(0, 0, 0, -10) == 180.0
    x, y = point_at_bearing(0, 0, 90, 5)
    assert abs(x - 5) < 1e-9 and abs(y) < 1e-9


def test_point_along_clamps():
    line = LineString([(0, 0), (10, 0)])
    assert point_along(line, -5).x == 0
    assert point_along(line, 50).x == 10
    assert point_along(line, 4).x == 4
