"""Core tables (plan section 5), as SQLModel on SQLite.

Geometry is stored as WKT in two columns: `geom_wkt` (WGS84 lon/lat, for output) and
`geom_m_wkt` (EPSG:32643, for metric work). Every table that can hold made-up data has a
`synthetic` flag; eval scripts must filter it out.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


class Meta(SQLModel, table=True):
    """Key/value provenance for the current DB (seeded_at, random_seed, osm attribution)."""

    key: str = Field(primary_key=True)
    value: str


class FootpathNode(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    osm_id: int | None = Field(default=None, index=True)
    lat: float
    lon: float
    x: float  # EPSG:32643
    y: float
    kind: str = "junction"  # junction | crossing_end | anchor


class FootpathEdge(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    u: int = Field(index=True)
    v: int = Field(index=True)
    geom_wkt: str
    geom_m_wkt: str
    length_m: float
    side: str = "none"  # L | R | none
    parent_road_osm_id: int | None = None
    kind: str  # sidewalk | footway | crossing | steps | pedestrian | road_shared
    synthesized: bool = False  # True for offset sidewalks / crossings we generated (P1)
    signal: bool | None = None  # crossings: signalised? None = unknown
    kerb_ramp_start: bool | None = None  # crossings: kerb ramp at the u end? None = unknown
    kerb_ramp_end: bool | None = None
    highway: str | None = None
    osm_tags: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    width_m: float | None = None
    state: str = "unknown"  # clear | blocked | unknown
    state_confidence: float = 0.0
    state_synthetic: bool = False  # True when the state came from `make seed`
    last_observed_at: datetime | None = None
    observed_by: str | None = None  # image | wheel | report
    synthetic: bool = False  # geometry origin: False for real OSM


class Coverage(SQLModel, table=True):
    """Observation summary per edge side (plan 6.2). Derived from images/rides; seeded in P0."""

    id: int | None = Field(default=None, primary_key=True)
    edge_id: int = Field(index=True)
    side: str = "none"
    observed: bool = False
    n_images: int = 0
    last_observed_at: datetime | None = None
    source: str = "image"  # image | wheel | report | seed
    synthetic: bool = False


class Anchor(SQLModel, table=True):
    id: str = Field(primary_key=True)
    kind: str  # metro | bus_stop | hospital | school
    name_en: str
    name_hi: str
    lat: float
    lon: float
    node_id: int | None = None
    snap_distance_m: float | None = None
    verified: bool = False
    source: str = ""
    synthetic: bool = False


class Image(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    source: str  # mapillary | own | report
    source_id: str | None = None
    lat: float
    lon: float
    heading_deg: float | None = None
    pitch_deg: float | None = None
    hfov_deg: float = 65.0
    captured_at: datetime | None = None
    width: int | None = None
    height: int | None = None
    path: str | None = None
    gps_accuracy_m: float | None = None
    attribution: str | None = None  # licence string, required for Mapillary
    sequence_id: str | None = None  # Mapillary sequence
    camera_type: str | None = None  # perspective | fisheye | spherical
    creator: str | None = None
    session_id: str | None = Field(default=None, index=True)  # own capture walk id
    note: str | None = None
    heading_source: str | None = None  # mapillary_computed | mapillary_compass | ios | absolute | relative | none
    url: str | None = None  # remote thumbnail url (expires for Mapillary)
    synthetic: bool = False


class Detection(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    image_id: int = Field(index=True)
    class_id: str = Field(index=True)
    score: float
    x1: float
    y1: float
    x2: float
    y2: float
    est_lat: float | None = None
    est_lon: float | None = None
    est_distance_m: float | None = None
    assigned_edge_id: int | None = Field(default=None, index=True)
    side: str | None = None
    snap_confidence: float | None = None
    synthetic: bool = False


class Barrier(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    class_id: str = Field(index=True)
    severity: int
    tags: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    edge_id: int = Field(index=True)
    side: str = "none"
    position_along_edge_m: float = 0.0
    lat: float
    lon: float
    permanent: bool = True
    time_profile: list[float] | None = Field(default=None, sa_column=Column(JSON))
    status: str = "active"  # active | fixed | expired | suspected
    confidence: float = 0.5
    sources: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    note: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    last_seen_at: datetime | None = None
    synthetic: bool = False


class Report(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    photo_image_id: int | None = None
    class_id: str
    severity: int
    note: str | None = None
    lat: float
    lon: float
    heading_deg: float | None = None
    status: str = "pending"  # pending | verified | rejected | fixed
    model_prescreen_score: float | None = None
    barrier_id: int | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    synthetic: bool = False


class Vote(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    report_id: int = Field(index=True)
    user_id: int
    value: str  # agree | disagree | unsure
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    display_name: str
    trust_score: float = 0.2
    profile: str = "walker"  # wheelchair_manual | elderly_walking_aid | pram | walker
    language: str = "en"
    synthetic: bool = False


class Ride(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    synthetic: bool = False


class RideSample(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    ride_id: int = Field(index=True)
    t: float
    lat: float | None = None
    lon: float | None = None
    gps_accuracy_m: float | None = None
    ax: float | None = None
    ay: float | None = None
    az: float | None = None


class EdgeRideStat(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    edge_id: int = Field(index=True)
    roughness_index: float | None = None
    n_traversals: int = 0
    last_traversed_at: datetime | None = None
    jolt_events: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))


class DemoRoute(SQLModel, table=True):
    """A pre-defined demo trip (e.g. Riya's). Always synthetic."""

    id: str = Field(primary_key=True)
    label_en: str
    label_hi: str
    origin_node_id: int
    destination_node_id: int
    origin_anchor_id: str | None = None
    path_wkt: str  # WGS84 LineString of the shortest walking path used for seeding
    length_m: float
    synthetic: bool = True
