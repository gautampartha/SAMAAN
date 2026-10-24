"""Train the SAMAAN detector (plan 6.3) with India-suited augmentation from config/train.yaml.

    python -m ml.train --name karkarduma_v1 [--epochs 60] [--model yolo11n.pt] [--run-name v1]

Weights land in ml/runs/<run-name>/weights/best.pt (gitignored). Ultralytics is AGPL-3.0.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import config
from common.paths import ROOT
from ml.dataset import dataset_dir, is_synthetic

RUNS_DIR = ROOT / "ml" / "runs"


def train(name: str, run_name: str, epochs: int | None = None, model: str | None = None, imgsz: int | None = None,
          batch: int | None = None, device: str | None = None, extra: dict | None = None) -> Path:
    from ultralytics import YOLO

    tcfg = config.load("train")
    data_yaml = dataset_dir(name) / "data.yaml"
    if not data_yaml.exists():
        raise FileNotFoundError(f"{data_yaml} missing: run `python -m ml.dataset split --name {name}`")
    m = YOLO(model or tcfg["model"])
    kwargs = dict(data=str(data_yaml), epochs=epochs or int(tcfg["epochs"]), imgsz=imgsz or int(tcfg["imgsz"]),
                  batch=batch or int(tcfg["batch"]), patience=int(tcfg["patience"]), seed=int(tcfg["seed"]),
                  deterministic=True, workers=int(tcfg["workers"]), project=str(RUNS_DIR), name=run_name, exist_ok=True,
                  verbose=False, plots=False, **tcfg["augment"], **(extra or {}))
    dev = device if device is not None else tcfg.get("device") or ""
    if dev:
        kwargs["device"] = dev
    m.train(**kwargs)
    best = RUNS_DIR / run_name / "weights" / "best.pt"
    meta = {"dataset": name, "synthetic": is_synthetic(name), "model": model or tcfg["model"], "epochs": kwargs["epochs"],
            "imgsz": kwargs["imgsz"], "augment": tcfg["augment"]}
    (RUNS_DIR / run_name / "samaan_train_meta.json").write_text(json.dumps(meta, indent=2))
    return best if best.exists() else RUNS_DIR / run_name / "weights" / "last.pt"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", required=True)
    ap.add_argument("--run-name", default=None)
    ap.add_argument("--epochs", type=int)
    ap.add_argument("--model")
    ap.add_argument("--imgsz", type=int)
    ap.add_argument("--batch", type=int)
    ap.add_argument("--device")
    args = ap.parse_args()
    best = train(args.name, args.run_name or args.name, args.epochs, args.model, args.imgsz, args.batch, args.device)
    print("weights:", best)


if __name__ == "__main__":
    main()
