"""Conversation brain for Listen mode: an OpenAI-compatible chat model (NVIDIA NIM) with tools.

The phone sends the recognised sentence plus context (location, current navigation step); the
model answers in one or two sentences and may call tools. `find_place` and `report_barrier` run
here against the SAMAAN database; `start_navigation`, `stop_navigation` and `repeat_step` are
returned to the app as actions (the app owns the navigation engine). Only text leaves the phone.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from common import config

log = logging.getLogger("samaan.voice.llm")

KEY_ENV = "NVIDIA_API_KEY"
CLIENT_ACTIONS = ("start_navigation", "stop_navigation", "repeat_step")
CLASS_IDS = [
    "steps_or_high_kerb", "parked_vehicle", "open_drain", "curb_ramp", "broken_surface", "fixed_obstacle",
    "vendor_encroachment", "bike_barrier", "construction", "waterlogging", "no_footpath", "footpath_end",
]


def vcfg() -> dict[str, Any]:
    return config.load("voice")


def api_key() -> str:
    return os.environ.get(KEY_ENV, "").strip()


def enabled() -> bool:
    return bool(api_key())


def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name, "description": description,
                                              "parameters": {"type": "object", "properties": properties, "required": required}}}


TOOLS: list[dict[str, Any]] = [
    _tool("find_place", "Search a campus place by name. Returns the top match with lat and lon.", {"query": {"type": "string"}}, ["query"]),
    _tool("start_navigation", "Start spoken turn-by-turn navigation to a place found with find_place. Only after the traveller agreed.",
          {"lat": {"type": "number"}, "lon": {"type": "number"}, "name": {"type": "string"}}, ["lat", "lon", "name"]),
    _tool("stop_navigation", "Stop the current navigation.", {}, []),
    _tool("repeat_step", "Repeat the current navigation instruction.", {}, []),
    _tool("report_barrier", "File a barrier report at the traveller's current location.",
          {"class_id": {"type": "string", "enum": CLASS_IDS}, "note": {"type": "string", "description": "What the traveller said, in their words"}},
          ["class_id"]),
]


def system_prompt(lang: str) -> str:
    language = "Hindi (Devanagari script, simple everyday words)" if lang == "hi" else "Indian English"
    return " ".join([
        f"You are SAMAAN, a calm voice guide for a blind or low-vision traveller walking on an Indian university campus. Speak {language}.",
        "Your words are read aloud: one or two short sentences, no lists, no markdown, no emojis. Never describe the screen. Never say coordinates or numbers from tool results aloud; use place names.",
        "Never invent places, distances or directions; everything comes from tools or the context messages.",
        "When the traveller names a place, call find_place with the place name in English when you know it (library, hostel, canteen, gate, lecture hall), otherwise as said; then read back the top match and ask whether to start.",
        "Use the lat and lon from the find_place result (kept in square brackets in your earlier turn) when calling start_navigation; never the traveller's own location.",
        "If they agree, call start_navigation with that match's lat, lon and name and say directions will follow. Do not start before they agree.",
        "When they ask where they are or what is next, answer only from the 'Navigation context' line; if there is none, say navigation has not started.",
        "When they say repeat, call repeat_step. When they say stop, finish or cancel, call stop_navigation and confirm.",
        "When they want to report, complain, or say something blocks the way: ask what it is if unclear, then call report_barrier with the closest class_id. Confirm in one sentence.",
        "When they ask for help, say what they can say: a place name, where am I, repeat, report, stop.",
        "If something failed, say so plainly and suggest the next thing to say.",
    ])


@dataclass
class ChatTurn:
    role: str
    content: str


@dataclass
class ChatResult:
    reply: str
    actions: list[dict[str, Any]] = field(default_factory=list)
    tool_log: list[dict[str, Any]] = field(default_factory=list)
    model: str | None = None

    @property
    def memory(self) -> str:
        """What the app stores as the assistant turn: the reply plus the facts the tools returned, so the
        next request still knows the coordinates of the place that was found."""
        facts = [t["result"] for t in self.tool_log if t["name"] == "find_place" and t["result"].startswith("Top match")]
        return f"{self.reply} [{' '.join(facts)}]" if facts else self.reply


def _post(url: str, key: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                          "Accept": "application/json", "User-Agent": "samaan-listen/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


class ModelError(Exception):
    pass


def _complete(messages: list[dict[str, Any]], post: Callable[..., dict[str, Any]]) -> tuple[dict[str, Any], str]:
    """Try the configured models in order; return (assistant message, model id)."""
    c = vcfg()
    key = api_key()
    if not key:
        raise ModelError("no_api_key")
    url = f"{str(c['base_url']).rstrip('/')}/chat/completions"
    last = "no model configured"
    for model in c["models"]:
        body = {"model": model, "messages": messages, "tools": TOOLS, "tool_choice": "auto",
                "temperature": float(c["temperature"]), "max_tokens": int(c["max_tokens"])}
        # e.g. chat_template_kwargs.enable_thinking=false for Nemotron: reasoning tokens cost seconds per reply
        body.update((c.get("model_extra") or {}).get(model) or {})
        try:
            data = post(url, key, body, float(c["timeout_s"]))
            msg = (data.get("choices") or [{}])[0].get("message") or {}
            return msg, model
        except urllib.error.HTTPError as e:
            last = f"{model}: HTTP {e.code}"
            log.warning("voice model %s failed: %s", model, e)
            if e.code in (401, 403):
                break
        except (urllib.error.URLError, TimeoutError, OSError, KeyError, ValueError) as e:
            last = f"{model}: {e}"
            log.warning("voice model %s failed: %s", model, e)
    raise ModelError(last)


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            v = json.loads(raw)
            return v if isinstance(v, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _default_reply(actions: list[dict[str, Any]], lang: str) -> str:
    names = [a["name"] for a in actions]
    if "start_navigation" in names:
        n = next(a for a in actions if a["name"] == "start_navigation")["args"].get("name", "")
        return (f"{n} की ओर मार्गदर्शन शुरू।" if lang == "hi" else f"Starting towards {n}. Directions will follow.").strip()
    if "stop_navigation" in names:
        return "मार्गदर्शन रोक दिया।" if lang == "hi" else "Navigation stopped."
    if "repeat_step" in names:
        return "दोहरा रहा हूँ।" if lang == "hi" else "Repeating."
    return "ठीक है।" if lang == "hi" else "Okay."


def chat(
    history: list[ChatTurn],
    *,
    lang: str,
    location: tuple[float, float] | None,
    nav_context: str | None,
    navigating: bool,
    run_tool: Callable[[str, dict[str, Any]], str],
    post: Callable[..., dict[str, Any]] | None = None,
) -> ChatResult:
    """One user utterance -> model (with tool rounds) -> spoken reply + app actions."""
    post = post or _post  # resolved at call time so tests can swap the transport
    c = vcfg()
    keep = int(c["history_turns"])
    context = []
    if location:
        context.append(f"Traveller location: lat {location[0]:.6f}, lon {location[1]:.6f}.")
    context.append(f"Navigation context: {nav_context}" if nav_context else "Navigation context: navigation has not started.")
    context.append("The traveller is currently navigating." if navigating else "No trip is running.")
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt(lang)}, {"role": "system", "content": " ".join(context)}]
    messages += [{"role": t.role, "content": t.content} for t in history[-keep:]]

    actions: list[dict[str, Any]] = []
    tool_log: list[dict[str, Any]] = []
    model_used: str | None = None
    for _round in range(int(c["max_tool_rounds"]) + 1):
        msg, model_used = _complete(messages, post)
        calls = msg.get("tool_calls") or []
        content = (msg.get("content") or "").strip()
        if not calls:
            return ChatResult(reply=content or _default_reply(actions, lang), actions=actions, tool_log=tool_log, model=model_used)
        messages.append({"role": "assistant", "content": content or None, "tool_calls": calls})
        for call in calls:
            fn = call.get("function") or {}
            name = str(fn.get("name") or "")
            args = _parse_args(fn.get("arguments"))
            if name in CLIENT_ACTIONS:
                actions.append({"name": name, "args": args})
                result = "ok"
            else:
                try:
                    result = run_tool(name, args)
                except Exception as e:
                    log.exception("voice tool %s failed", name)
                    result = f"{name} failed: {e}"
            tool_log.append({"name": name, "args": args, "result": result})
            messages.append({"role": "tool", "tool_call_id": call.get("id") or name, "name": name, "content": result})
    return ChatResult(reply=_default_reply(actions, lang), actions=actions, tool_log=tool_log, model=model_used)
