"""Listen-mode conversation (POST /voice/chat) and its config (GET /voice/config).

Speech recognition and speech output happen on the phone. The recognised sentence, the
traveller's location and the current navigation step come here; an OpenAI-compatible model
(NVIDIA NIM, config/voice.yaml, key in NVIDIA_API_KEY) answers in one or two sentences and may
call tools: find_place / report_barrier run here, start/stop/repeat navigation go back to the app
as actions. Without a key the app keeps its rule-based on-device dialogue.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from api.db import get_session
from api.models import User
from api.routers.search import search_places
from api.services import voice_llm
from api.services.reports import ReportError, create_report, create_user, report_item

log = logging.getLogger("samaan.voice")
router = APIRouter(prefix="/voice", tags=["voice"])

VOICE_USER_NAME = "Voice traveller"
TOOL_NAMES = tuple(t["function"]["name"] for t in voice_llm.TOOLS)


@router.get("/config")
def voice_config() -> dict[str, Any]:
    on = voice_llm.enabled()
    c = voice_llm.vcfg()
    return {"enabled": on, "provider": c["provider"] if on else None, "model": c["models"][0] if on else None, "tools": list(TOOL_NAMES)}


class Turn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=2000)


class Location(BaseModel):
    lat: float
    lon: float
    accuracy_m: float | None = None


class ChatIn(BaseModel):
    messages: list[Turn] = Field(min_length=1, max_length=40)
    lang: str = Field("en", pattern="^(en|hi)$")
    user_id: int | str | None = None
    location: Location | None = None
    nav_context: str | None = Field(None, max_length=600)
    navigating: bool = False


def _voice_user(session: Session, language: str) -> User:
    u = session.exec(select(User).where(User.display_name == VOICE_USER_NAME)).first()
    if u is None:
        u = create_user(session, VOICE_USER_NAME, "blind_low_vision", language, team=False)
    return u


def run_tool(session: Session, name: str, args: dict[str, Any], *, lang: str, location: tuple[float, float] | None, user_id: int | str | None) -> str:
    """Execute a server-side tool; the returned string is what the model reads."""
    if name == "find_place":
        q = str(args.get("query") or "").strip()
        if not q:
            return "No place name given."
        hits = search_places(session, q, 3)
        if not hits:
            return f"No place matching '{q}' in this zone. Ask the traveller for another name."
        parts = []
        for i, h in enumerate(hits):
            nm = h.get("name_hi") if lang == "hi" and h.get("name_hi") else h.get("name_en")
            parts.append(f"{'Top match' if i == 0 else 'Other'}: {nm} (lat {h['lat']:.6f}, lon {h['lon']:.6f})")
        return ". ".join(parts) + "."
    if name == "report_barrier":
        if location is None:
            return "Cannot report: the traveller's location is unknown. Ask them to allow location access."
        class_id = str(args.get("class_id") or "fixed_obstacle")
        user = None
        try:
            user = session.get(User, int(user_id)) if user_id is not None else None
        except (TypeError, ValueError):
            user = None
        if user is None:
            user = _voice_user(session, lang)
        note = str(args.get("note") or "Reported by voice in Listen mode, no photo.")[:280]
        try:
            rep = create_report(session, user_id=int(user.id), class_id=class_id, severity=3, lat=location[0], lon=location[1],
                                photo=None, note=note, device_lat=location[0], device_lon=location[1])
        except ReportError as e:
            return f"Report failed: {e.code}."
        item = report_item(session, rep)
        return f"Report {item['id']} sent for {class_id}, status {item['status']}. Thank the traveller; others will confirm it."
    return f"Unknown tool {name}."


@router.post("/chat")
def chat(body: ChatIn, session: Session = Depends(get_session)) -> dict[str, Any]:
    if not voice_llm.enabled():
        raise HTTPException(503, "voice model not configured (NVIDIA_API_KEY)")
    loc = (body.location.lat, body.location.lon) if body.location else None
    history = [voice_llm.ChatTurn(t.role, t.content) for t in body.messages]
    try:
        res = voice_llm.chat(
            history,
            lang=body.lang,
            location=loc,
            nav_context=body.nav_context,
            navigating=body.navigating,
            run_tool=lambda name, args: run_tool(session, name, args, lang=body.lang, location=loc, user_id=body.user_id),
        )
    except voice_llm.ModelError as e:
        raise HTTPException(502, f"voice model unavailable: {e}") from e
    return {"reply": res.reply, "memory": res.memory, "actions": res.actions, "tool_log": res.tool_log, "model": res.model}
