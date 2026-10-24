"""SAMAAN API. Graph is loaded into memory at startup (plan section 4)."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, func, select

from api.db import get_session, init_db
from api.models import Barrier, FootpathEdge, Meta
from api.routers import images, layers, missions, reach, reports, rides, route, search
from api.services.routing import build_context
from common import config
from pipeline.graph.osm import load_nx_from_db

log = logging.getLogger("samaan.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = init_db()
    with Session(engine) as session:
        app.state.graph = load_nx_from_db(session)
        app.state.routing = build_context(session)
        app.state.meta = {m.key: m.value for m in session.exec(select(Meta)).all()}
    g = app.state.graph
    log.info("graph loaded: %d nodes, %d edges", g.number_of_nodes(), g.number_of_edges())
    if g.number_of_edges() == 0:
        log.warning("empty graph: run `make seed` first")
    yield


app = FastAPI(title="SAMAAN API", version="0.0.1", lifespan=lifespan)

_origins = os.environ.get("SAMAAN_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in _origins], allow_methods=["*"],
                   allow_headers=["*"])
app.include_router(layers.router)
app.include_router(images.router)
app.include_router(route.router)
app.include_router(search.router)
app.include_router(reports.router)
app.include_router(missions.router)
app.include_router(reach.router)
app.include_router(rides.router)


@app.get("/health")
def health(session: Session = Depends(get_session)) -> dict[str, Any]:
    meta = {m.key: m.value for m in session.exec(select(Meta)).all()}
    return {"status": "ok", "zone": config.zone()["name"], "synthetic": meta.get("synthetic") == "true",
            "edges": session.exec(select(func.count(FootpathEdge.id))).one(),
            "barriers": session.exec(select(func.count(Barrier.id))).one(),
            "graph_nodes": app.state.graph.number_of_nodes(), "graph_edges": app.state.graph.number_of_edges()}


@app.get("/zone")
def zone() -> dict[str, Any]:
    z = config.zone()
    return {"name": z["name"], "display_name": z["display_name"], "bbox": z["bbox"], "center": z["center"],
            "crs": z["crs"], "basemap": z["basemap"],
            "attribution": {"osm": z["osm"]["attribution"], "basemap": z["basemap"]["attribution"]},
            "anchors": [a["id"] for a in z.get("anchors", [])]}


@app.get("/meta")
def meta(session: Session = Depends(get_session)) -> dict[str, str]:
    return {m.key: m.value for m in session.exec(select(Meta)).all()}
