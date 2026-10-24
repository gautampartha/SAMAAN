"""GET /search: places, anchors, streets and demo destinations by name (en/hi substring)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from api.db import get_session
from api.models import Anchor, DemoRoute, FootpathNode, Place

router = APIRouter(tags=["search"])
KIND_LABEL = {"street": {"en": "Street", "hi": "सड़क"}, "anchor": {"en": "Landmark", "hi": "प्रमुख स्थान"},
              "demo": {"en": "Demo destination", "hi": "डेमो गंतव्य"}}


def _match(q: str, *names: str | None) -> int:
    """0 = no match, 3 = starts with, 2 = word start, 1 = substring."""
    best = 0
    for n in names:
        if not n:
            continue
        low = n.lower()
        if low.startswith(q):
            best = max(best, 3)
        elif any(w.startswith(q) for w in low.replace("-", " ").split()):
            best = max(best, 2)
        elif q in low:
            best = max(best, 1)
    return best


def search_places(session: Session, q: str, limit: int) -> list[dict[str, Any]]:
    q = q.strip().lower()
    if not q:
        return []
    results: list[tuple[int, dict[str, Any]]] = []
    for a in session.exec(select(Anchor)).all():
        score = _match(q, a.name_en, a.name_hi, a.id)
        if score:
            results.append((score + 1, {"id": f"anchor:{a.id}", "name_en": a.name_en, "name_hi": a.name_hi, "kind": "anchor",
                                        "lat": a.lat, "lon": a.lon, "subtitle_en": a.kind.replace("_", " "),
                                        "subtitle_hi": KIND_LABEL["anchor"]["hi"]}))
    for d in session.exec(select(DemoRoute)).all():
        score = _match(q, d.label_en, d.label_hi, d.id, "riya", "demo")
        if score:
            n = session.get(FootpathNode, d.destination_node_id)
            results.append((score + 1, {"id": f"demo:{d.id}", "name_en": d.label_en, "name_hi": d.label_hi, "kind": "demo",
                                        "lat": n.lat, "lon": n.lon, "subtitle_en": KIND_LABEL["demo"]["en"],
                                        "subtitle_hi": KIND_LABEL["demo"]["hi"], "synthetic": True}))
    for p in session.exec(select(Place)).all():
        score = _match(q, p.name_en, p.name_hi)
        if score:
            kind = "street" if p.kind == "street" else "place"
            sub_en = KIND_LABEL["street"]["en"] if kind == "street" else p.kind.split("=")[-1].replace("_", " ")
            results.append((score, {"id": f"place:{p.id}", "name_en": p.name_en, "name_hi": p.name_hi, "kind": kind,
                                    "lat": p.lat, "lon": p.lon, "subtitle_en": sub_en,
                                    "subtitle_hi": KIND_LABEL["street"]["hi"] if kind == "street" else sub_en}))
    results.sort(key=lambda r: (-r[0], r[1]["name_en"].lower()))
    return [r for _, r in results[:limit]]


@router.get("/search")
def search(q: str = Query("", max_length=80), limit: int = Query(8, ge=1, le=50), session: Session = Depends(get_session)) -> dict[str, Any]:
    return {"query": q, "results": search_places(session, q, limit)}
