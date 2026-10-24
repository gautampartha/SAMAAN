"""Footpath synthesis (plan 6.1): roads -> left/right sidewalks, crossings, connected footways.

Input: an undirected, projected (EPSG:32643) OSM graph of all pedestrian-usable ways, plus the
OSM `highway=crossing` nodes. Output: a new MultiGraph F whose edges are footpath segments:

  sidewalk    offset curve of a road at (half width + extra), trimmed at junctions; side L/R
  crossing    across a road, at junction rings and at mid-block OSM crossing nodes
  corner      (kind "sidewalk", tag corner=True) link between sidewalks of adjacent roads at a junction
  connector   OSM footway endpoint -> nearest sidewalk, or junction node -> sidewalk corners
  footway/steps/crossing/pedestrian   real OSM ways, kept as they are
  road_shared roads tagged sidewalk=no (or driveways etc.): walking on the carriageway

Junction rule: at each road node, the endpoints of all incident (trimmed) sidewalks are sorted
by bearing around the node. Consecutive endpoints of the SAME road form a crossing; consecutive
endpoints of DIFFERENT roads form a corner link. A dead end therefore gets one crossing
around its tip. OSM tags on the node (traffic_signals, crossing=*, kerb=*) set `signal` and
`kerb_ramp_*` on the crossings; otherwise they stay None (unknown until observed).
"""
from __future__ import annotations

import itertools
import logging
import re
from dataclasses import dataclass, field
from typing import Any

import networkx as nx
from shapely import STRtree
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import substring

from common.crs import METRIC
from common.geo import bearing_deg

log = logging.getLogger(__name__)

NodeKey = tuple  # ("osm", osm_node_id) | ("sw", sidewalk_id, dist_rounded)

FOOTWAY_HIGHWAYS = {"footway", "path", "pedestrian", "steps", "corridor"}


@dataclass
class Sidewalk:
    sid: int
    road_key: tuple[Any, Any, Any]
    side: str
    line: LineString
    parent_osmid: int | None
    tags: dict[str, Any]
    splits: set[float] = field(default_factory=set)

    def key(self, dist: float) -> NodeKey:
        return ("sw", self.sid, round(dist, 3))

    @property
    def start(self) -> NodeKey:
        return self.key(0.0)

    @property
    def end(self) -> NodeKey:
        return self.key(self.line.length)


@dataclass
class Link:
    a: NodeKey
    b: NodeKey
    kind: str
    tags: dict[str, Any] = field(default_factory=dict)
    geometry: LineString | None = None
    side: str = "none"
    parent_osmid: int | None = None
    signal: bool | None = None
    kerb_ramp_start: bool | None = None
    kerb_ramp_end: bool | None = None
    synthesized: bool = True


# ----------------------------------------------------------------------------- helpers


def _scalar(v: Any) -> Any:
    return v[0] if isinstance(v, list) and v else v


def _parse_metres(v: Any) -> float | None:
    """'10', '10 m', '10.5m', '3.5;4' -> metres (first number). Feet ('12\'') are ignored."""
    v = _scalar(v)
    if v is None:
        return None
    m = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)\s*(m|meters?|metres?)?\s*$", str(v).split(";")[0])
    return float(m.group(1)) if m else None


def _parse_int(v: Any) -> int | None:
    v = _scalar(v)
    try:
        return int(float(str(v).split(";")[0]))
    except (TypeError, ValueError):
        return None


def road_half_width(data: dict[str, Any], cfg: dict[str, Any]) -> float:
    """Half width from `width`, else lanes x lane_width / 2, else per-class default."""
    w = _parse_metres(data.get("width"))
    if w and w > 0:
        return w / 2.0
    lanes = _parse_int(data.get("lanes"))
    if lanes and lanes > 0:
        return lanes * float(cfg["lane_width_m"]) / 2.0
    hw = _scalar(data.get("highway"))
    defaults = cfg["default_half_width_m_by_highway"]
    return float(defaults.get(hw, defaults["default"]))


def classify(data: dict[str, Any], cfg: dict[str, Any]) -> str:
    """'sidewalk' | 'shared' | 'footway' | 'steps' | 'skip' for an OSM way."""
    hw = _scalar(data.get("highway"))
    if hw is None:
        return "skip"
    if hw == "steps":
        return "steps"
    if hw in FOOTWAY_HIGHWAYS:
        return "footway"
    if hw not in cfg["synthesize_for_highway"]:
        return "shared"
    sidewalk = _scalar(data.get("sidewalk"))
    if sidewalk in ("no", "none"):
        return "shared"
    if hw == "service" and _scalar(data.get("service")) in cfg["shared_service_types"]:
        return "shared"
    return "sidewalk"


def sides_for(data: dict[str, Any]) -> list[str]:
    sidewalk = _scalar(data.get("sidewalk"))
    if sidewalk == "left":
        return ["L"]
    if sidewalk == "right":
        return ["R"]
    return ["L", "R"]


def _oriented_geometry(G: nx.MultiGraph, u: Any, v: Any, data: dict[str, Any]) -> LineString:
    geom = data.get("geometry")
    if geom is None:
        return LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])])
    x0, y0 = geom.coords[0]
    du = (x0 - G.nodes[u]["x"]) ** 2 + (y0 - G.nodes[u]["y"]) ** 2
    dv = (x0 - G.nodes[v]["x"]) ** 2 + (y0 - G.nodes[v]["y"]) ** 2
    return geom if du <= dv else LineString(list(geom.coords)[::-1])


def _single_line(geom: Any) -> LineString | None:
    if geom is None or geom.is_empty:
        return None
    if isinstance(geom, MultiLineString):
        return max(geom.geoms, key=lambda g: g.length)
    if isinstance(geom, LineString):
        return geom
    return None


def _tri(v: Any) -> bool | None:
    """OSM yes/no-ish values -> True/False/None."""
    v = _scalar(v)
    if v in ("yes", "true", "1", "lowered", "flush", "traffic_signals", "signals"):
        return True
    if v in ("no", "false", "0", "raised", "rolled"):
        return False
    return None


def crossing_attrs_from_tags(tags: dict[str, Any]) -> dict[str, Any]:
    """signal / kerb ramp flags from OSM crossing-node tags; None = unknown."""
    crossing = _scalar(tags.get("crossing"))
    hw = _scalar(tags.get("highway"))
    signal: bool | None
    if hw == "traffic_signals" or crossing == "traffic_signals" or _tri(tags.get("crossing:signals")):
        signal = True
    elif crossing in ("uncontrolled", "unmarked", "marked", "zebra"):
        signal = False
    else:
        signal = None
    kerb = _tri(tags.get("kerb"))
    return {"signal": signal, "kerb_ramp_start": kerb, "kerb_ramp_end": kerb}


def _way_tags(data: dict[str, Any]) -> dict[str, Any]:
    return {k: _scalar(v) for k, v in data.items()
            if k not in ("geometry", "length", "osmid") and isinstance(_scalar(v), (str, int, float, bool))}


# ----------------------------------------------------------------------------- synthesis


def synthesize(G: nx.MultiGraph, crossing_nodes: list[dict[str, Any]], cfg: dict[str, Any]) -> tuple[nx.MultiGraph, dict[str, int]]:
    """Build the footpath graph F from the OSM way graph G (undirected, EPSG:32643)."""
    extra = float(cfg["sidewalk_offset_extra_m"])
    min_len = float(cfg["min_sidewalk_length_m"])

    # 1. classify every way and compute road offsets
    cls: dict[tuple, str] = {}
    offset: dict[tuple, float] = {}
    for u, v, k, d in G.edges(keys=True, data=True):
        c = classify(d, cfg)
        cls[(u, v, k)] = c
        if c in ("sidewalk", "shared"):
            offset[(u, v, k)] = road_half_width(d, cfg) + extra

    def incident_roads(n: Any) -> list[tuple]:
        out = []
        for a, b, k in G.edges(n, keys=True):
            key = (a, b, k) if (a, b, k) in cls else (b, a, k)
            if cls.get(key) in ("sidewalk", "shared"):
                out.append(key)
        return out

    def setback(n: Any, own: tuple) -> float:
        others = [offset[k] for k in incident_roads(n) if k != own]
        return max(others) if others else 0.0

    sidewalks: dict[int, Sidewalk] = {}
    by_road: dict[tuple, dict[str, Sidewalk]] = {}
    links: list[Link] = []
    road_geoms: dict[tuple, LineString] = {}
    stats = {"sidewalk": 0, "shared": 0, "footway": 0, "steps": 0, "short_fallback": 0,
             "crossing_junction": 0, "corner": 0, "crossing_midblock": 0, "connector": 0,
             "footway_dangling": 0, "skipped": 0}

    # 2. sidewalks (offset + trim) and kept ways
    for u, v, k, d in G.edges(keys=True, data=True):
        key, c = (u, v, k), cls[(u, v, k)]
        if c == "skip":
            stats["skipped"] += 1
            continue
        geom = _oriented_geometry(G, u, v, d)
        tags = _way_tags(d)
        osmid = _scalar(d.get("osmid"))
        osmid = int(osmid) if isinstance(osmid, int) else None
        if c in ("footway", "steps"):
            kind = "steps" if c == "steps" else (
                "crossing" if _scalar(d.get("footway")) == "crossing" else
                "pedestrian" if _scalar(d.get("highway")) == "pedestrian" else "footway")
            link = Link(("osm", u), ("osm", v), kind, tags, geom, parent_osmid=osmid, synthesized=False)
            if kind == "crossing":
                link.__dict__.update(crossing_attrs_from_tags(tags))
            links.append(link)
            stats[c] += 1
            continue
        if c == "sidewalk":
            road_geoms[key] = geom
            off = offset[key]
            sb_u, sb_v = setback(u, key), setback(v, key)
            made: dict[str, Sidewalk] = {}
            ok = True
            for side in sides_for(d):
                raw = _single_line(geom.offset_curve(off if side == "L" else -off))
                if raw is None or raw.length - sb_u - sb_v < min_len:
                    ok = False
                    break
                line = substring(raw, sb_u, raw.length - sb_v)
                if not isinstance(line, LineString) or line.length < min_len:
                    ok = False
                    break
                sid = len(sidewalks) + 1
                sw = Sidewalk(sid, key, side, line, osmid, tags)
                sidewalks[sid] = sw
                made[side] = sw
            if ok and made:
                by_road[key] = made
                stats["sidewalk"] += len(made)
                continue
            for sw in made.values():  # roll back a half-made road
                sidewalks.pop(sw.sid, None)
            stats["short_fallback"] += 1
            c = "shared"
            cls[key] = "shared"
        # shared carriageway
        links.append(Link(("osm", u), ("osm", v), "road_shared", tags, geom, parent_osmid=osmid, synthesized=False))
        stats["shared"] += 1

    # 3. junctions: a crossing between each road's own L/R sidewalk ends; corner links between
    #    the facing ends of angularly adjacent roads; hub connectors where footways / shared
    #    roads end at the node itself.
    for n in G.nodes:
        nx_, ny_ = G.nodes[n]["x"], G.nodes[n]["y"]
        node_pt = Point(nx_, ny_)
        roads_here: list[dict[str, Any]] = []
        for key, sws in by_road.items():
            u, v, _ = key
            if u == v or n not in (u, v):
                continue
            geom = road_geoms[key]
            out_pt = geom.interpolate(min(5.0, geom.length)) if u == n else geom.interpolate(max(geom.length - 5.0, 0.0))
            road_bearing = bearing_deg(nx_, ny_, out_pt.x, out_pt.y)
            ends: list[tuple[float, Sidewalk, NodeKey, Point]] = []
            for sw in sws.values():
                pt = Point(sw.line.coords[0]) if u == n else Point(sw.line.coords[-1])
                key_n = sw.start if u == n else sw.end
                rel = (bearing_deg(nx_, ny_, pt.x, pt.y) - road_bearing) % 360.0
                ends.append((rel, sw, key_n, pt))
            if not ends:
                continue
            ends.sort(key=lambda e: e[0])
            cw = ends[0] if ends[0][0] <= 180.0 else ends[-1]       # clockwise side of the road
            ccw = ends[-1] if ends[-1][0] > 180.0 else ends[0]      # counter-clockwise side
            roads_here.append({"key": key, "bearing": road_bearing, "cw": cw, "ccw": ccw, "n_ends": len(ends)})
        if not roads_here:
            continue
        node_tags = {kk: _scalar(vv) for kk, vv in G.nodes[n].items() if kk not in ("x", "y", "lon", "lat")}
        xattrs = crossing_attrs_from_tags(node_tags)
        for r in roads_here:
            if r["n_ends"] == 2:
                (_, swa, ka, pa), (_, _swb, kb, pb) = r["ccw"], r["cw"]
                links.append(Link(ka, kb, "crossing", {"at_junction": True}, LineString([pa, pb]),
                                  parent_osmid=swa.parent_osmid, signal=xattrs["signal"],
                                  kerb_ramp_start=xattrs["kerb_ramp_start"], kerb_ramp_end=xattrs["kerb_ramp_end"]))
                stats["crossing_junction"] += 1
        roads_here.sort(key=lambda r: r["bearing"])
        m = len(roads_here)
        if m >= 2:
            for i in range(m):
                a, b = roads_here[i], roads_here[(i + 1) % m]
                if m == 2 and i == 1:
                    break
                (_, _, ka, pa), (_, _, kb, pb) = a["cw"], b["ccw"]
                if ka == kb:
                    continue
                links.append(Link(ka, kb, "sidewalk", {"corner": True}, LineString([pa, pb])))
                stats["corner"] += 1
        hub_needed = any(cls.get((a, b, k) if (a, b, k) in cls else (b, a, k)) in ("footway", "steps", "shared")
                         for a, b, k in G.edges(n, keys=True))
        if hub_needed:
            seen: set[NodeKey] = set()
            for r in roads_here:
                for _, _, kk, pt in (r["cw"], r["ccw"]):
                    if kk in seen:
                        continue
                    seen.add(kk)
                    links.append(Link(("osm", n), kk, "connector", {"via_junction": True}, LineString([node_pt, pt])))
                    stats["connector"] += 1

    # 4. mid-block OSM crossing nodes -> split both sidewalks and add a crossing
    road_keys = list(road_geoms)
    road_tree = STRtree([road_geoms[k] for k in road_keys]) if road_keys else None
    match_d = float(cfg["crossing_node_match_distance_m"])
    graph_nodes = set(G.nodes)
    for cn in crossing_nodes:
        if cn["id"] in graph_nodes or road_tree is None:
            continue  # junction crossings are handled by the ring above
        pt = Point(cn["x"], cn["y"])
        idx = road_tree.nearest(pt)
        if idx is None:
            continue
        key = road_keys[int(idx)]
        if road_geoms[key].distance(pt) > match_d or key not in by_road:
            continue
        sws = by_road[key]
        if "L" not in sws or "R" not in sws:
            continue
        ends: list[NodeKey] = []
        pts: list[Point] = []
        for side in ("L", "R"):
            sw = sws[side]
            d = sw.line.project(pt)
            d = 0.0 if d < 0.5 else sw.line.length if d > sw.line.length - 0.5 else round(d, 3)
            if 0.0 < d < sw.line.length:
                sw.splits.add(d)
            ends.append(sw.key(d))
            pts.append(sw.line.interpolate(d))
        xattrs = crossing_attrs_from_tags(cn["tags"])
        links.append(Link(ends[0], ends[1], "crossing", {"osm_crossing_node": cn["id"], **{k: v for k, v in cn["tags"].items()}},
                          LineString(pts), parent_osmid=sws["L"].parent_osmid, **xattrs))
        stats["crossing_midblock"] += 1

    # 5. connect dangling OSM footway endpoints to the nearest sidewalk within the limit
    sw_ids = list(sidewalks)
    sw_tree = STRtree([sidewalks[s].line for s in sw_ids]) if sw_ids else None
    connect_d = float(cfg["footway_connect_distance_m"])
    hub_nodes = {n for n in G.nodes if incident_roads(n)}
    footway_ends = {lk.a[1] for lk in links if lk.kind in ("footway", "steps", "pedestrian", "crossing") and lk.a[0] == "osm"}
    footway_ends |= {lk.b[1] for lk in links if lk.kind in ("footway", "steps", "pedestrian", "crossing") and lk.b[0] == "osm"}
    for n in footway_ends:
        if n in hub_nodes or sw_tree is None:
            continue
        if G.degree(n) > 1:
            continue  # interior footway node, already connected to other footways
        pt = Point(G.nodes[n]["x"], G.nodes[n]["y"])
        idx = sw_tree.nearest(pt)
        sw = sidewalks[sw_ids[int(idx)]]
        dist = sw.line.distance(pt)
        if dist > connect_d:
            stats["footway_dangling"] += 1
            continue
        d = sw.line.project(pt)
        d = 0.0 if d < 0.5 else sw.line.length if d > sw.line.length - 0.5 else round(d, 3)
        if 0.0 < d < sw.line.length:
            sw.splits.add(d)
        target = sw.line.interpolate(d)
        if dist < 0.05:
            links.append(Link(("osm", n), sw.key(d), "connector", {"zero_length": True}, LineString([pt, target])))
        else:
            links.append(Link(("osm", n), sw.key(d), "connector", {}, LineString([pt, target])))
        stats["connector"] += 1

    # 6. assemble F. Links shorter than the merge tolerance (coincident corner ends,
    #    zero-length connectors) collapse their two end keys into one node.
    merge_tol = float(cfg.get("node_merge_tolerance_m", 0.5))
    parent: dict[NodeKey, NodeKey] = {}

    def find(k: NodeKey) -> NodeKey:
        while parent.get(k, k) != k:
            parent[k] = parent.get(parent[k], parent[k])
            k = parent[k]
        return k

    def union(a: NodeKey, b: NodeKey) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    kept_links: list[Link] = []
    for lk in links:
        if lk.kind in ("sidewalk", "connector") and lk.geometry is not None and lk.geometry.length < merge_tol:
            union(lk.a, lk.b)
            stats["merged_tiny_links"] = stats.get("merged_tiny_links", 0) + 1
        else:
            kept_links.append(lk)
    links = kept_links

    F = nx.MultiGraph(crs=METRIC)
    ids: dict[NodeKey, int] = {}

    def node_id(key: NodeKey, pt: Point, kind: str = "junction") -> int:
        key = find(key)
        if key not in ids:
            ids[key] = len(ids) + 1
            F.add_node(ids[key], x=float(pt.x), y=float(pt.y), kind=kind,
                       osm_id=int(key[1]) if key[0] == "osm" and isinstance(key[1], int) else None)
        return ids[key]

    for sw in sidewalks.values():
        cuts = sorted({0.0, round(sw.line.length, 3)} | {round(s, 3) for s in sw.splits})
        for d0, d1 in itertools.pairwise(cuts):
            seg = substring(sw.line, d0, d1)
            if not isinstance(seg, LineString) or seg.length <= 0:
                continue
            a = node_id(sw.key(d0), Point(seg.coords[0]))
            b = node_id(sw.key(d1), Point(seg.coords[-1]))
            F.add_edge(a, b, kind="sidewalk", side=sw.side, geometry=seg, length=float(seg.length),
                       parent_road_osm_id=sw.parent_osmid, osm_tags=sw.tags, synthesized=True,
                       highway=sw.tags.get("highway"), signal=None, kerb_ramp_start=None, kerb_ramp_end=None)
    # sidewalk end keys use the exact length; links created with sw.end use the same rounding
    for lk in links:
        geom = lk.geometry
        if geom is None:
            continue
        a = node_id(lk.a, Point(geom.coords[0]))
        b = node_id(lk.b, Point(geom.coords[-1]))
        if a == b:
            continue
        F.add_edge(a, b, kind=lk.kind, side=lk.side, geometry=geom, length=float(geom.length),
                   parent_road_osm_id=lk.parent_osmid, osm_tags=lk.tags, synthesized=lk.synthesized,
                   highway=lk.tags.get("highway"), signal=lk.signal,
                   kerb_ramp_start=lk.kerb_ramp_start, kerb_ramp_end=lk.kerb_ramp_end)
    for a, b, d in F.edges(data=True):
        if d["kind"] == "crossing":
            F.nodes[a]["kind"] = "crossing_end"
            F.nodes[b]["kind"] = "crossing_end"
    # Road centrelines (for side-of-road decisions in P4), in the same orientation as the
    # sidewalk L/R convention.
    centrelines = []
    for u, v, k, d in G.edges(keys=True, data=True):
        key = (u, v, k)
        if cls.get(key) not in ("sidewalk", "shared"):
            continue
        geom = road_geoms.get(key) or _oriented_geometry(G, u, v, d)
        osmid = _scalar(d.get("osmid"))
        centrelines.append({"osm_id": int(osmid) if isinstance(osmid, int) else None, "geometry": geom,
                            "highway": _scalar(d.get("highway")), "name": _scalar(d.get("name")),
                            "half_width_m": offset.get(key, 0.0) - extra, "has_sidewalks": cls.get(key) == "sidewalk"})
    F.graph["road_centrelines"] = centrelines
    log.info("synthesised footpath graph: %d nodes, %d edges, %s", F.number_of_nodes(), F.number_of_edges(), stats)
    return F, stats
