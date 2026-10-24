from __future__ import annotations

from functools import cache
from pathlib import Path
from typing import Any

import yaml

from common.paths import CONFIG_DIR

CONFIG_NAMES = ("zone", "profiles", "taxonomy", "fix_costs", "pipeline")


@cache
def load(name: str, config_dir: Path | None = None) -> dict[str, Any]:
    path = (config_dir or CONFIG_DIR) / f"{name}.yaml"
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise TypeError(f"{path} must contain a mapping at top level")
    return data


def zone() -> dict[str, Any]:
    return load("zone")


def profiles() -> dict[str, Any]:
    return load("profiles")


def taxonomy() -> dict[str, Any]:
    return load("taxonomy")


def fix_costs() -> dict[str, Any]:
    return load("fix_costs")


def pipeline() -> dict[str, Any]:
    return load("pipeline")


def bbox_tuple(zone_cfg: dict[str, Any] | None = None) -> tuple[float, float, float, float]:
    """(west, south, east, north) in WGS84."""
    b = (zone_cfg or zone())["bbox"]
    return (b["west"], b["south"], b["east"], b["north"])


def all_class_ids(tax: dict[str, Any] | None = None) -> list[str]:
    t = tax or taxonomy()
    return [c["id"] for c in t["detector_classes"]] + [c["id"] for c in t["other_classes"]]


def detector_class_ids(tax: dict[str, Any] | None = None) -> list[str]:
    return [c["id"] for c in (tax or taxonomy())["detector_classes"]]


def class_names(tax: dict[str, Any] | None = None) -> dict[str, dict[str, str]]:
    t = tax or taxonomy()
    out: dict[str, dict[str, str]] = {}
    for c in t["detector_classes"] + t["other_classes"]:
        out[c["id"]] = c["name"]
    return out


def temporary_classes(tax: dict[str, Any] | None = None) -> set[str]:
    t = tax or taxonomy()
    return {c["id"] for c in t["detector_classes"] + t["other_classes"] if c.get("temporary")}
