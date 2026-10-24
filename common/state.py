"""Segment state (plan 6.5): blocked / clear / unknown."""
from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

CLEAR, BLOCKED, UNKNOWN = "clear", "blocked", "unknown"


def is_impassable(profile_rules: dict[str, Any], barrier_class: str, severity: int) -> bool:
    rule = profile_rules.get(barrier_class)
    if not rule:
        return False
    threshold = rule.get("impassable_at_or_above")
    return threshold is not None and severity >= threshold


def impassable_for_any_profile(profiles_cfg: dict[str, Any], barrier_class: str, severity: int) -> bool:
    return any(
        is_impassable(p.get("rules", {}), barrier_class, severity)
        for p in profiles_cfg["profiles"].values()
    )


def compute_edge_state(
    barriers: Iterable[dict[str, Any]],
    observed: bool,
    last_observed_at: datetime | None,
    profiles_cfg: dict[str, Any],
    staleness_days: int,
    now: datetime,
) -> tuple[str, float]:
    """Return (state, confidence).

    barriers: dicts with keys class, severity, status ('active' | 'fixed' | 'expired').
    An edge is blocked if any active barrier is impassable for at least one profile.
    Otherwise clear if observed within the staleness window, else unknown.
    """
    active = [b for b in barriers if b.get("status", "active") == "active"]
    if any(impassable_for_any_profile(profiles_cfg, b["class"], int(b["severity"])) for b in active):
        conf = max((float(b.get("confidence", 0.5)) for b in active), default=0.5)
        return BLOCKED, conf
    if observed and last_observed_at is not None and now - last_observed_at <= timedelta(days=staleness_days):
        return CLEAR, 0.8
    return UNKNOWN, 0.0
