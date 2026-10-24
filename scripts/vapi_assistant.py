"""Create or update the SAMAAN Listen assistant in a Vapi account (needs the PRIVATE key).

    VAPI_PRIVATE_KEY=... python scripts/vapi_assistant.py --api-url https://<tunnel> [--lang en|hi]

Prints the assistant id; export it as VAPI_ASSISTANT_ID for the API so the phone starts this
assistant by id (public keys often forbid transient assistants). Re-run whenever the tunnel URL
changes: the tools' server URL is baked into the assistant. Nothing here is stored in the repo.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

NAME = "SAMAAN Listen"
CLASS_IDS = [
    "steps_or_high_kerb", "parked_vehicle", "open_drain", "curb_ramp", "broken_surface", "fixed_obstacle",
    "vendor_encroachment", "bike_barrier", "construction", "waterlogging", "no_footpath", "footpath_end",
]
VOICE = {"en": {"provider": "azure", "voiceId": "en-IN-NeerjaNeural"}, "hi": {"provider": "azure", "voiceId": "hi-IN-SwaraNeural"}}


def system_prompt(lang: str) -> str:
    language = "Hindi (Devanagari script, simple everyday words)" if lang == "hi" else "Indian English"
    return " ".join([
        f"You are SAMAAN, a calm voice guide for a blind or low-vision traveller walking on an Indian university campus. Speak {language}.",
        "Keep every reply to one or two short sentences. Never describe the screen. Never invent places, distances or directions.",
        "Flow: when the traveller names a place, call find_place with their words. Read back the top match in one sentence and ask \"Shall I start?\".",
        "If they agree, call start_navigation with that match's lat, lon and name, then say that directions will follow. Do not start before they agree.",
        "When they ask where they are, or what is next, answer only from the latest \"Navigation context\" system message; if there is none, say navigation has not started.",
        "When they say repeat, call repeat_step. When they say stop, finish, or cancel, call stop_navigation and confirm.",
        "When they want to report, complain, or say something blocks the way: ask what it is if unclear, then call report_barrier with class_id from this list: "
        + ", ".join(CLASS_IDS) + " and lat, lon from the latest \"Traveller location\" system message. Confirm in one sentence.",
        "When they ask for help, list what they can say: a place name, where am I, repeat, report, stop, goodbye.",
        "When they say goodbye or end the call, say goodbye briefly and end the call.",
        "The traveller's id is {{user_id}}, language code {{lang}}, starting location lat {{lat}} lon {{lon}}.",
    ])


def tool(url: str, name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"type": "function", "async": False, "server": {"url": url, "timeoutSeconds": 20},
            "function": {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": required}}}


def assistant_body(api_url: str, lang: str) -> dict:
    url = f"{api_url.rstrip('/')}/voice/tools"
    return {
        "name": NAME if lang == "en" else f"{NAME} (hi)",
        "firstMessage": "You are in Listen mode. Say where you want to go, or say help." if lang == "en" else "आप लिसन मोड में हैं। बोलें कि कहाँ जाना है, या मदद बोलें।",
        "firstMessageMode": "assistant-speaks-first",
        "maxDurationSeconds": 1800,
        "endCallPhrases": ["goodbye", "bye bye", "अलविदा"],
        "transcriber": {"provider": "deepgram", "model": "nova-2", "language": lang},
        "voice": VOICE[lang],
        "model": {
            "provider": "openai", "model": "gpt-4o-mini", "temperature": 0.2,
            "messages": [{"role": "system", "content": system_prompt(lang)}],
            "tools": [
                tool(url, "find_place", "Search a campus place by name. Returns the top match with lat and lon.", {"query": {"type": "string"}}, ["query"]),
                tool(url, "start_navigation", "Start spoken turn-by-turn navigation to a place found with find_place. Only after the traveller agreed.",
                     {"lat": {"type": "number"}, "lon": {"type": "number"}, "name": {"type": "string"}}, ["lat", "lon", "name"]),
                tool(url, "stop_navigation", "Stop the current navigation.", {}, []),
                tool(url, "repeat_step", "Repeat the current navigation instruction.", {}, []),
                tool(url, "report_barrier", "File a barrier report at the traveller's current location.",
                     {"class_id": {"type": "string", "enum": CLASS_IDS}, "lat": {"type": "number"}, "lon": {"type": "number"},
                      "note": {"type": "string"}, "user_id": {"type": "string"}}, ["class_id", "lat", "lon"]),
            ],
        },
        "clientMessages": ["transcript", "tool-calls", "tool-calls-result", "speech-update", "status-update"],
        "serverMessages": ["tool-calls"],
    }


def call(method: str, path: str, key: str, body: dict | None = None) -> dict | list:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"https://api.vapi.ai{path}", data=data, method=method,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Vapi {method} {path} -> {e.code}: {e.read().decode()[:400]}") from e


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api-url", required=True, help="public URL of the SAMAAN API (the tunnel)")
    ap.add_argument("--lang", default="en", choices=["en", "hi"])
    args = ap.parse_args()
    key = os.environ.get("VAPI_PRIVATE_KEY", "").strip()
    if not key:
        print("set VAPI_PRIVATE_KEY (Vapi dashboard -> API keys -> private key)", file=sys.stderr)
        return 1
    body = assistant_body(args.api_url, args.lang)
    existing = [a for a in call("GET", "/assistant", key) if a.get("name") == body["name"]]
    if existing:
        aid = existing[0]["id"]
        call("PATCH", f"/assistant/{aid}", key, body)
        print(f"updated {body['name']}: {aid}")
    else:
        created = call("POST", "/assistant", key, body)
        aid = created["id"]
        print(f"created {body['name']}: {aid}")
    print(f"\nexport VAPI_ASSISTANT_ID={aid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
