"""Evaluate a detector on the held-out test street (plan 6.3 / 8): per-class P/R at the configured
confidence and AP50, IoU-matched with ml/metrics.py.

    python -m ml.eval --name karkarduma_v1 --weights ml/runs/karkarduma_v1/weights/best.pt

Writes eval/results/detector_<name>_<tag>.{json,md} for real datasets. Synthetic datasets are
written to data/processed/smoke_results/ only when --allow-synthetic is given (rule 11.2).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from common import config
from ml.common import (
    class_names,
    image_size,
    label_path_for,
    load_gts,
    predict,
    provenance,
    results_dir_for,
    split_files,
)
from ml.dataset import dataset_dir
from ml.metrics import markdown_table, per_class_metrics, summarize


def evaluate(name: str, weights: str | Path, split: str = "test", class_map: dict[str, str] | None = None,
             device: str = "") -> dict[str, Any]:
    tcfg = config.load("train")["eval"]
    names = class_names()
    files = split_files(name, split)
    preds = predict(weights, files, float(tcfg["min_conf_for_ap"]), int(config.load("train")["imgsz"]), class_map, device)
    images = []
    for f in files:
        w, h = image_size(f)
        images.append((preds.get(f, []), load_gts(label_path_for(f), w, h, names)))
    metrics = per_class_metrics(images, [names[i] for i in sorted(names)], float(tcfg["conf_threshold"]),
                                float(tcfg["iou_threshold"]))
    splits = json.loads((dataset_dir(name) / "splits.json").read_text())
    return {"metrics": metrics, "summary": summarize(metrics), "split": split, "test_streets": splits.get(split),
            "n_images": len(files), "n_gt": sum(len(g) for _, g in images),
            "conf_threshold": tcfg["conf_threshold"], "iou_threshold": tcfg["iou_threshold"]}


def write_results(name: str, weights: str | Path, result: dict[str, Any], tag: str, allow_synthetic: bool) -> Path:
    out_dir = results_dir_for(name, allow_synthetic)
    payload = {**provenance(name, weights), **result}
    base = out_dir / f"detector_{name}_{tag}"
    base.with_suffix(".json").write_text(json.dumps(payload, indent=2, default=str))
    md = [f"# Detector evaluation: {name} ({tag})", "",
          (f"Weights `{weights}` · split `{result['split']}` (streets: {result['test_streets']}) · "
          f"{result['n_images']} images, {result['n_gt']} boxes · P/R at conf ≥ {result['conf_threshold']}, IoU ≥ {result['iou_threshold']} · "
          f"git {payload['git']} · {payload['generated_at']}"), ""]
    if payload["synthetic"]:
        md.append("**SYNTHETIC SMOKE DATA — not an evaluation result.**\n")
    md.append(markdown_table(result["metrics"], "Per class"))
    s = result["summary"]
    md.append(f"\nMacro precision {s['macro_precision']}, macro recall {s['macro_recall']}, mAP50 {s['map50']} "
              f"over {s['classes_with_gt']} classes with ground truth.\n")
    base.with_suffix(".md").write_text("\n".join(md))
    return base.with_suffix(".md")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", required=True)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--tag", default="ours")
    ap.add_argument("--device", default="")
    ap.add_argument("--allow-synthetic", action="store_true", help="smoke runs only; never for the pitch")
    args = ap.parse_args()
    res = evaluate(args.name, args.weights, args.split, device=args.device)
    path = write_results(args.name, args.weights, res, args.tag, args.allow_synthetic)
    print(markdown_table(res["metrics"], f"{args.name} / {args.tag}"))
    print("written", path)


if __name__ == "__main__":
    main()
