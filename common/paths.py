from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
GROUND_TRUTH_DIR = DATA_DIR / "ground_truth"


def db_path() -> Path:
    """SQLite path. Override with SAMAAN_DB (used by tests and demo mode)."""
    return Path(os.environ.get("SAMAAN_DB", PROCESSED_DIR / "samaan.sqlite"))
