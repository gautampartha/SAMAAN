"""GET /search over anchors, demo destination and places; OSM place extraction."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from api.models import Place
from pipeline.graph.osm import extract_places

OSM = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
 <node id="1" lat="28.6480" lon="77.3050"><tag k="name" v="Karkardooma Court"/><tag k="amenity" v="courthouse"/></node>
 <node id="2" lat="28.6481" lon="77.3051"><tag k="name" v="Unnamed-ish"/></node>
 <node id="3" lat="28.6482" lon="77.3052"/>
 <node id="4" lat="28.6483" lon="77.3053"/>
 <node id="5" lat="28.9" lon="77.9"><tag k="name" v="Far away"/><tag k="shop" v="bakery"/></node>
 <way id="10"><nd ref="3"/><nd ref="4"/><tag k="name" v="Vikas Marg"/><tag k="highway" v="primary"/></way>
 <way id="11"><nd ref="3"/><nd ref="4"/><tag k="name" v="Vikas Marg"/><tag k="highway" v="primary"/></way>
 <way id="12"><nd ref="3"/><nd ref="4"/><tag k="name" v="Shyam Park"/><tag k="name:hi" v="श्याम पार्क"/><tag k="leisure" v="park"/></way>
 <way id="13"><nd ref="3"/><nd ref="4"/><tag k="name" v="Shyam Park"/><tag k="leisure" v="park"/></way>
</osm>
"""


def test_extract_places(tmp_path):
    xml = tmp_path / "z.osm"
    xml.write_text(OSM)
    cfg = {"bbox": {"south": 28.6, "west": 77.2, "north": 28.7, "east": 77.4}}
    places = extract_places(xml, cfg)
    kinds = {(p["name_en"], p["kind"]) for p in places}
    assert ("Karkardooma Court", "amenity=courthouse") in kinds
    assert ("Vikas Marg", "street") in kinds and sum(1 for p in places if p["kind"] == "street") == 1
    parks = [p for p in places if p["name_en"] == "Shyam Park"]
    assert len(parks) == 1 and parks[0]["name_hi"] == "श्याम पार्क" and parks[0]["osm_type"] == "way"
    assert not any(p["name_en"] in ("Unnamed-ish", "Far away") for p in places)


@pytest.fixture(scope="module")
def client(toy_db):
    from api.db import get_engine
    from api.main import app

    with Session(get_engine(toy_db)) as s:
        s.add(Place(osm_id=1, kind="amenity=school", name_en="Scottish Early Years", name_hi="स्कॉटिश अर्ली इयर्स", lat=28.648, lon=77.305))
        s.add(Place(osm_id=None, kind="street", name_en="Bhartendu Harish Chandra Marg", lat=28.649, lon=77.306))
        s.commit()
    with TestClient(app) as c:
        yield c


def test_search_ranks_and_localises(client):
    r = client.get("/search", params={"q": "scot"}).json()
    assert r["results"][0]["name_en"] == "Scottish Early Years" and r["results"][0]["kind"] == "place"
    assert r["results"][0]["subtitle_en"] == "school" and r["results"][0]["name_hi"]
    r = client.get("/search", params={"q": "marg"}).json()
    assert any(x["kind"] == "street" and x["subtitle_hi"] == "सड़क" for x in r["results"])
    r = client.get("/search", params={"q": "metro"}).json()
    assert r["results"][0]["kind"] == "anchor" and r["results"][0]["id"] == "anchor:metro_karkarduma"
    r = client.get("/search", params={"q": "friend"}).json()
    assert r["results"][0]["kind"] == "demo" and r["results"][0]["synthetic"] is True
    assert client.get("/search", params={"q": ""}).json()["results"] == []
    assert client.get("/search", params={"q": "zzzz"}).json()["results"] == []
    assert len(client.get("/search", params={"q": "a", "limit": 2}).json()["results"]) <= 2
