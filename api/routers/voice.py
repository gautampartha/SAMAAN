"""Voice agent (Vapi) support for Listen mode.

The phone talks to Vapi directly with the *public* key (served by GET /voice/config so the app
needs no rebuild when the key changes). The assistant is created transiently by the app; its tools
point back here (POST /voice/tools, reachable through the tunnel) so the LLM can search places,
file a barrier report, and ask the app to start / stop / repeat navigation. Keys live in the
environment only: VAPI_PUBLIC_KEY (never committed).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlmodel import Session, select

from api.db import get_session
from api.models import User
from api.routers.search import search_places
from api.services.reports import ReportError, create_report, create_user, report_item
from common import config

log = logging.getLogger("samaan.voice")
router = APIRouter(prefix="/voice", tags=["voice"])

PUBLIC_KEY_ENV = "VAPI_PUBLIC_KEY"
ASSISTANT_ID_ENV = "VAPI_ASSISTANT_ID"
VOICE_USER_NAME = "Voice traveller"

TOOL_NAMES = ("find_place", "report_barrier", "start_navigation", "stop_navigation", "repeat_step", "where_am_i")


@router.get("/config")
def voice_config() -> dict[str, Any]:
    key = os.environ.get(PUBLIC_KEY_ENV, "").strip()
    assistant_id = os.environ.get(ASSISTANT_ID_ENV, "").strip() or None
    # Public keys may forbid transient (inline) assistants; then the app starts the pre-created one by id
    # (scripts/vapi_assistant.py creates/updates it with the private key, never shipped to the phone).
    return {"enabled": bool(key), "provider": "vapi" if key else None, "public_key": key or None, "assistant_id": assistant_id, "tools": list(TOOL_NAMES)}


def _args(call: dict[str, Any]) -> dict[str, Any]:
    fn = call.get("function") or {}
    raw = fn.get("arguments", {})
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            raw = {}
    return raw if isinstance(raw, dict) else {}


def _name(call: dict[str, Any]) -> str:
    fn = call.get("function") or {}
    return str(fn.get("name") or call.get("name") or "")


def _voice_user(session: Session, language: str) -> User:
    u = session.exec(select(User).where(User.display_name == VOICE_USER_NAME)).first()
    if u is None:
        u = create_user(session, VOICE_USER_NAME, "blind_low_vision", language, team=False)
    return u


def _float(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def run_tool(session: Session, name: str, args: dict[str, Any], variables: dict[str, Any], lang: str) -> str:
    """Execute one tool; returns the flat string Vapi reads back to the LLM."""
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
        class_id = str(args.get("class_id") or "fixed_obstacle")
        lat = _float(args.get("lat")) or _float(variables.get("lat"))
        lon = _float(args.get("lon")) or _float(variables.get("lon"))
        if lat is None or lon is None:
            return "Cannot report: the traveller's location is unknown. Ask them to allow location access."
        uid = args.get("user_id") or variables.get("user_id")
        user = None
        try:
            user = session.get(User, int(uid)) if uid is not None else None
        except (TypeError, ValueError):
            user = None
        if user is None:
            user = _voice_user(session, lang)
        note = str(args.get("note") or "Reported by voice (Vapi) in Listen mode, no photo.")[:280]
        try:
            rep = create_report(session, user_id=int(user.id), class_id=class_id, severity=3, lat=lat, lon=lon, photo=None, note=note,
                                device_lat=lat, device_lon=lon)
        except ReportError as e:
            return f"Report failed: {e.code}."
        item = report_item(session, rep)
        return f"Report {item['id']} sent for {class_id}, status {item['status']}. Thank the traveller; others will confirm it."
    if name in ("start_navigation", "stop_navigation", "repeat_step"):
        # The app acts on the tool-calls client message; the LLM only needs an acknowledgement.
        return "ok"
    if name == "where_am_i":
        return "Answer from the latest 'Navigation context' system message; if there is none, say navigation has not started."
    return f"Unknown tool {name}."


@router.post("/tools")
async def tools_webhook(request: Request, session: Session = Depends(get_session)) -> dict[str, Any]:
    body = await request.json()
    msg = body.get("message") or {}
    if msg.get("type") != "tool-calls":
        return {"results": []}
    calls = msg.get("toolCallList") or msg.get("toolCalls") or []
    call_info = msg.get("call") or {}
    variables = ((call_info.get("assistantOverrides") or {}).get("variableValues")) or {}
    lang = str(variables.get("lang") or "en")
    results = []
    for c in calls:
        name = _name(c)
        try:
            text = run_tool(session, name, _args(c), variables, lang)
            results.append({"toolCallId": c.get("id"), "result": text})
        except Exception as e:  # noqa: BLE001 - always answer Vapi with 200
            log.exception("voice tool %s failed", name)
            results.append({"toolCallId": c.get("id"), "error": f"{name} failed: {e}"})
    return {"results": results}
