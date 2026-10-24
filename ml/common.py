"""Shared helpers for the ML scripts: loading YOLO labels, running a model over images,
provenance for result files."""
from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from common import config
from common.paths import ROOT
from ml.dataset import dataset_dir, is_synthetic, read_manifest
from ml.metrics import GT, Det

RESULTS_DIR = ROOT / "eval" / "results"
SMOKE_RESULTS_DIR = ROOT / "data" / "processed" / "smoke_results"


def class_names() -> dict[int, str]:
    return {c["yolo_index"]: c["id"] for c in config.taxonomy()["detector_classes"]}


def image_size(path: Path) -> tuple[int, int]:
    from PIL import Image as PILImage

    with PILImage.open(path) as im:
        return im.size  # (w, h)


def load_gts(label_path: Path, w: int, h: int, names: dict[int, str]) -> list[GT]:
    out: list[GT] = []
    if not label_path.exists():
        return out
    for line in label_path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        ci, cx, cy, bw, bh = int(parts[0]), *map(float, parts[1:5])
        out.append(GT(names[ci], ((cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h)))
    return out


def split_files(name: str, split: str) -> list[Path]:
    p = dataset_dir(name) / f"{split}.txt"
    if not p.exists():
        raise FileNotFoundError(f"{p} missing: run `python -m ml.dataset split --name {name}` first")
    return [Path(line.strip()) for line in p.read_text().splitlines() if line.strip()]


def label_path_for(img: Path) -> Path:
    return Path(str(img.parent).replace("images", "labels")) / (img.stem + ".txt")


def predict(weights: str | Path, files: list[Path], min_conf: float, imgsz: int, class_map: dict[str, str] | None = None,
            device: str = "") -> dict[Path, list[Det]]:
    """Run an Ultralytics model and return detections per file in pixel xyxy. `class_map` renames
    the model's class names into taxonomy ids (domain-gap baseline); unmapped classes are dropped."""
    from ultralytics import YOLO

    model = YOLO(str(weights))
    out: dict[Path, list[Det]] = {f: [] for f in files}
    if not files:
        return out
    for res in model.predict([str(f) for f in files], conf=min_conf, imgsz=imgsz, verbose=False, stream=True,
                             device=device or None):
        f = Path(res.path)
        dets: list[Det] = []
        names = res.names
        for b in res.boxes:
            raw = names[int(b.cls.item())]
            cid = class_map.get(raw) if class_map is not None else raw
            if cid is None:
                continue
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            dets.append(Det(cid, float(b.conf.item()), (x1, y1, x2, y2)))
        out[f] = dets
    return out


def git_commit() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:  # noqa: BLE001  # pragma: no cover
        return "unknown"


def results_dir_for(name: str, allow_synthetic: bool = False) -> Path:
    """eval/results/ for real datasets; synthetic datasets go to data/processed/smoke_results/.
    Rule 11.2: synthetic data never produces an eval output."""
    if is_synthetic(name):
        if not allow_synthetic:
            raise RuntimeError(f"dataset {name} is synthetic: refusing to write to eval/results/")
        d = SMOKE_RESULTS_DIR
    else:
        d = RESULTS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def provenance(name: str, weights: str | Path, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    rows = read_manifest(name)
    return {"dataset": name, "synthetic": is_synthetic(name), "weights": str(weights), "git": git_commit(),
            "generated_at": datetime.now(UTC).isoformat(), "images_in_dataset": len(rows), **(extra or {})}


def dump(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, default=str))
