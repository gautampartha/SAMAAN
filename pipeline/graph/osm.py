"""Download the zone from OpenStreetMap and build the P0 walking graph.

P0 uses OSM's walkable ways directly (side = none). P1 replaces this with synthesised
left/right sidewalks and crossings (plan 6.1) behind the same `write_graph` interface.

Data source: the OSM main API `/api/0.6/map` (Overpass is blocked on the build network).
Licence: ODbL 1.0, attribution stored in the Meta table and returned by the API.
"""
from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import networkx as nx
import osmnx as ox
import requests
from shapely import wkt
from shapely.geometry import LineString, Point
from sqlmodel import Session, select

from api.models import Anchor, FootpathEdge, FootpathNode, Meta
from common.crs import METRIC, to_wgs84
from common.paths import ROOT

log = logging.getLogger(__name__)

# Tags we need on ways and nodes (plan 6.1 step 1). Set before any graph_from_xml call.
WAY_TAGS = ["highway", "name", "oneway", "lanes", "width", "sidewalk", "sidewalk:left", "sidewalk:right",
            "sidewalk:both", "kerb", "crossing", "wheelchair", "surface", "smoothness", "lit", "footway",
            "step_count", "ramp", "ramp:wheelchair", "incline", "handrail", "tactile_paving", "service",
            "foot", "area", "access", "bridge", "tunnel", "layer", "maxspeed", "junction"]
NODE_TAGS = ["ref", "highway", "crossing", "kerb", "tactile_paving", "crossing:signals", "traffic_signals",
             "wheelchair", "railway", "entrance"]
ox.settings.useful_tags_way = sorted(set(ox.settings.useful_tags_way) | set(WAY_TAGS))
ox.settings.useful_tags_node = sorted(set(ox.settings.useful_tags_node) | set(NODE_TAGS))
USER_AGENT = "SAMAAN-hackathon/0.0.1 (accessible routing research; SC-02)"

# osmnx "walk" filter, replicated because graph_from_xml takes no network_type.
_NON_WALK_HIGHWAY = re.compile(
    r"abandoned|bus_guideway|construction|cycleway|motor|no|planned|platform|proposed|raceway|razed"
)


def fetch_osm_xml(zone_cfg: dict[str, Any], force: bool = False) -> Path:
    """Fetch the bbox as OSM XML (cached). Returns the cache path."""
    osm = zone_cfg["osm"]
    cache = ROOT / osm["raw_cache"]
    if cache.exists() and not force:
        log.info("using cached OSM XML %s", cache)
        return cache
    b = zone_cfg["bbox"]
    bbox = f"{b['west']},{b['south']},{b['east']},{b['north']}"
    url = osm["osm_api_url"]
    log.info("downloading OSM XML for bbox=%s from %s", bbox, url)
    r = requests.get(url, params={"bbox": bbox}, headers={"User-Agent": USER_AGENT}, timeout=120)
    r.raise_for_status()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(r.content)
    return cache


def _is_walkable(data: dict[str, Any]) -> bool:
    hw = data.get("highway")
    if hw is None:
        return False
    hws = hw if isinstance(hw, list) else [hw]
    if all(_NON_WALK_HIGHWAY.search(str(h)) for h in hws):
        return False
    if data.get("area") == "yes":
        return False
    if data.get("foot") == "no":
        return False
    return data.get("service") != "private"


def load_walk_graph(xml_path: Path) -> nx.MultiDiGraph:
    """OSM XML -> simplified, bidirectional, walkable MultiDiGraph in WGS84."""
    G = ox.graph_from_xml(xml_path, bidirectional=True, simplify=False, retain_all=True)
    drop = [(u, v, k) for u, v, k, d in G.edges(keys=True, data=True) if not _is_walkable(d)]
    G.remove_edges_from(drop)
    G.remove_nodes_from([n for n in G.nodes if G.degree(n) == 0])
    G = ox.simplify_graph(G)
    # Keep the largest weakly connected component: isolated fragments are not routable.
    G = ox.truncate.largest_component(G, strongly=False)
    return G


def kind_for(data: dict[str, Any]) -> str:
    hw = data.get("highway")
    hw = hw[0] if isinstance(hw, list) else hw
    if hw == "steps":
        return "steps"
    if hw == "footway":
        if data.get("footway") == "crossing":
            return "crossing"
        if data.get("footway") == "sidewalk":
            return "sidewalk"
        return "footway"
    if hw in ("path", "pedestrian", "living_street"):
        return "footway" if hw == "path" else "pedestrian"
    return "road_shared"


def _scalar(v: Any) -> Any:
    return v[0] if isinstance(v, list) and v else v


def write_graph(G_proj: nx.MultiGraph, session: Session, synthetic: bool = False) -> dict[int, int]:
    """Write a projected (EPSG:32643) graph to FootpathNode / FootpathEdge.

    Accepts a MultiGraph or MultiDiGraph. In P0 the zone graph is written UNDIRECTED
    (one row per way segment) so a barrier or a state applies to the segment, not to
    one direction of it. Node attrs required: x, y (metric). Edge attrs: length (m),
    optional geometry, highway. Returns a mapping graph-node-id -> DB node id.
    """
    node_ids: dict[int, int] = {}
    for n, d in G_proj.nodes(data=True):
        lon, lat = to_wgs84(Point(d["x"], d["y"])).coords[0]
        osm_id = d.get("osm_id", n if isinstance(n, int) and "kind" not in d else None)
        row = FootpathNode(
            osm_id=int(osm_id) if isinstance(osm_id, int) else None,
            lat=float(lat), lon=float(lon), x=float(d["x"]), y=float(d["y"]),
            kind=str(d.get("kind", "junction")),
        )
        session.add(row)
        session.flush()
        node_ids[n] = row.id
    for u, v, k, d in G_proj.edges(keys=True, data=True):
        geom_m = d.get("geometry")
        if geom_m is None:
            geom_m = LineString([(G_proj.nodes[u]["x"], G_proj.nodes[u]["y"]),
                                 (G_proj.nodes[v]["x"], G_proj.nodes[v]["y"])])
        geom_ll = to_wgs84(geom_m)
        if "osm_tags" in d:  # synthesised graph (P1): attributes are explicit
            tags = dict(d["osm_tags"])
            kind = d["kind"]
            parent = d.get("parent_road_osm_id")
        else:  # raw OSM way graph (P0 / tests)
            tags = {key: _scalar(val) for key, val in d.items()
                    if key not in ("geometry", "length", "osmid") and isinstance(_scalar(val), (str, int, float, bool))}
            kind = kind_for(d)
            osmid = _scalar(d.get("osmid"))
            parent = int(osmid) if isinstance(osmid, int) else None
        session.add(FootpathEdge(
            u=node_ids[u], v=node_ids[v],
            geom_wkt=geom_ll.wkt, geom_m_wkt=geom_m.wkt,
            length_m=float(d.get("length", geom_m.length)),
            side=str(d.get("side", "none")),
            parent_road_osm_id=int(parent) if isinstance(parent, int) else None,
            kind=kind,
            highway=_scalar(d.get("highway", tags.get("highway"))),
            osm_tags=tags,
            width_m=_to_float(tags.get("width")),
            synthesized=bool(d.get("synthesized", False)),
            signal=d.get("signal"),
            kerb_ramp_start=d.get("kerb_ramp_start"),
            kerb_ramp_end=d.get("kerb_ramp_end"),
            state="unknown",
            synthetic=synthetic,
        ))
    session.commit()
    return node_ids


def _to_float(v: Any) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def crossing_nodes(xml_path: Path, zone_cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """OSM nodes tagged highway=crossing (or traffic_signals with crossing=*) inside the bbox,
    with metric coordinates and their tags."""
    from common.crs import lonlat_to_xy

    b = zone_cfg["bbox"]
    out: list[dict[str, Any]] = []
    for _, el in ET.iterparse(xml_path, events=("end",)):
        if el.tag != "node":
            continue
        tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
        if tags.get("highway") == "crossing" or (tags.get("highway") == "traffic_signals" and "crossing" in tags):
            lat, lon = float(el.get("lat")), float(el.get("lon"))
            if b["south"] <= lat <= b["north"] and b["west"] <= lon <= b["east"]:
                x, y = lonlat_to_xy(lon, lat)
                out.append({"id": int(el.get("id")), "x": x, "y": y, "lat": lat, "lon": lon, "tags": tags})
        el.clear()
    return out


def discover_anchors(xml_path: Path, zone_cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Find anchor POIs (metro entrances, bus stops, hospitals, schools) as OSM nodes in the bbox."""
    disc = zone_cfg.get("anchor_discovery", {})
    if not disc.get("enabled"):
        return []
    wanted = {(t["key"], t["value"]): t["kind"] for t in disc["osm_tags"]}
    b = zone_cfg["bbox"]
    out: list[dict[str, Any]] = []
    for _, el in ET.iterparse(xml_path, events=("end",)):
        if el.tag != "node":
            continue
        tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
        for (k, v), kind in wanted.items():
            if tags.get(k) == v:
                lat, lon = float(el.get("lat")), float(el.get("lon"))
                if b["south"] <= lat <= b["north"] and b["west"] <= lon <= b["east"]:
                    name = tags.get("name", "")
                    out.append({
                        "id": f"osm_{kind}_{el.get('id')}",
                        "kind": kind,
                        "name": {"en": tags.get("name:en", name) or kind.replace("_", " ").title(),
                                 "hi": tags.get("name:hi", name) or kind},
                        "lat": lat, "lon": lon,
                        "source": f"OSM node {el.get('id')} ({k}={v})",
                        "verified": False,
                    })
        el.clear()
    return out


def write_anchors(anchors: list[dict[str, Any]], session: Session) -> None:
    """Snap anchors to the nearest graph node (in metric space) and store them."""
    nodes = session.exec(select(FootpathNode)).all()
    if not nodes:
        raise RuntimeError("write_anchors needs nodes in the DB")
    xs = [n.x for n in nodes]
    ys = [n.y for n in nodes]
    from common.crs import lonlat_to_xy

    for a in anchors:
        x, y = lonlat_to_xy(a["lon"], a["lat"])
        best = min(range(len(nodes)), key=lambda i: (xs[i] - x) ** 2 + (ys[i] - y) ** 2)
        dist = ((xs[best] - x) ** 2 + (ys[best] - y) ** 2) ** 0.5
        session.merge(Anchor(
            id=a["id"], kind=a["kind"],
            name_en=a["name"]["en"], name_hi=a["name"]["hi"],
            lat=a["lat"], lon=a["lon"],
            node_id=nodes[best].id, snap_distance_m=float(dist),
            verified=bool(a.get("verified", False)),
            source=a.get("source", ""),
            synthetic=bool(a.get("synthetic", False)),
        ))
    session.commit()


def write_meta(session: Session, **kv: str) -> None:
    for k, v in kv.items():
        session.merge(Meta(key=k, value=str(v)))
    session.commit()


def load_nx_from_db(session: Session) -> nx.Graph:
    """In-memory undirected graph for routing/reach, built from FootpathEdge rows.

    Edge attributes: id, length_m, kind, state, geometry (metric LineString).
    Node attributes: x, y (metric), lat, lon.
    """
    G = nx.Graph()
    for n in session.exec(select(FootpathNode)).all():
        G.add_node(n.id, x=n.x, y=n.y, lat=n.lat, lon=n.lon)
    for e in session.exec(select(FootpathEdge)).all():
        # Keep the shorter of parallel edges for the undirected routing graph.
        if G.has_edge(e.u, e.v) and G[e.u][e.v]["length_m"] <= e.length_m:
            continue
        G.add_edge(e.u, e.v, id=e.id, length_m=e.length_m, kind=e.kind, state=e.state,
                   geometry=wkt.loads(e.geom_m_wkt))
    return G


def build_zone_graph(zone_cfg: dict[str, Any], session: Session, force_download: bool = False,
                     synthesis_cfg: dict[str, Any] | None = None) -> nx.MultiGraph:
    """Full graph build: download (cached) -> walkable OSM ways -> project -> synthesise footpaths
    (plan 6.1) -> DB. Returns the footpath MultiGraph F."""
    from common import config
    from pipeline.graph.synthesize import synthesize

    synthesis_cfg = synthesis_cfg or config.pipeline()["footpath_synthesis"]
    xml_path = fetch_osm_xml(zone_cfg, force=force_download)
    G = load_walk_graph(xml_path)
    G_proj = ox.project_graph(G, to_crs=METRIC)
    G_und = ox.convert.to_undirected(G_proj)  # one edge per segment; walking is bidirectional
    F, stats = synthesize(G_und, crossing_nodes(xml_path, zone_cfg), synthesis_cfg)
    write_graph(F, session, synthetic=False)
    write_zone_anchors(xml_path, zone_cfg, session)
    write_meta(
        session,
        osm_attribution=zone_cfg["osm"]["attribution"],
        osm_source=f"{zone_cfg['osm']['osm_api_url']} bbox={zone_cfg['bbox']}",
        osm_fetched_at=datetime.fromtimestamp(xml_path.stat().st_mtime, tz=UTC).isoformat(),
        crs_metric=METRIC,
        graph_source="synthesised from OSM (pipeline.graph.synthesize)",
        graph_built_at=datetime.now(UTC).isoformat(),
        synthesis_stats=str(stats),
    )
    return F


def write_zone_anchors(xml_path: Path | None, zone_cfg: dict[str, Any], session: Session) -> None:
    """Config anchors + anchors discovered in the cached OSM XML, snapped to graph nodes."""
    anchors = list(zone_cfg.get("anchors", []))
    if xml_path is not None and xml_path.exists():
        anchors += discover_anchors(xml_path, zone_cfg)
    write_anchors(anchors, session)
