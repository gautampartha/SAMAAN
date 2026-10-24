"""Domain-gap experiment (plan 6.3): a non-Indian baseline vs our fine-tuned model on the same
Indian test street, per-class precision/recall side by side.

    python -m ml.domain_gap --name karkarduma_v1 --ours ml/runs/karkarduma_v1/weights/best.pt \
        [--baseline path.pt --baseline-map config/domain_gap.yaml]

The baseline weights and class map come from config/domain_gap.yaml (human task: RampNet weights
or a model trained on non-Indian Mapillary labels). Classes the baseline does not predict are
reported as "not in baseline", never as zero.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

from common.paths import ROOT
from ml.common import provenance, results_dir_for
from ml.eval import evaluate


def compare(name: str, ours: str | Path, baseline: str | Path | None, class_map: dict[str, str], device: str = "") -> dict[str, Any]:
    ours_res = evaluate(name, ours, device=device)
    base_res = evaluate(name, baseline, class_map=class_map, device=device) if baseline else None
    shared = set(class_map.values())
    rows = []
    for cls, m in ours_res["metrics"].items():
        b = base_res["metrics"].get(cls) if base_res else None
        rows.append({"class": cls, "n_gt": m["n_gt"], "ours_precision": m["precision"], "ours_recall": m["recall"],
                     "ours_ap50": m["ap50"],
                     "baseline_precision": (b["precision"] if b and cls in shared else None),
                     "baseline_recall": (b["recall"] if b and cls in shared else None),
                     "baseline_ap50": (b["ap50"] if b and cls in shared else None),
                     "in_baseline": cls in shared and baseline is not None})
    return {"rows": rows, "test_streets": ours_res["test_streets"], "n_images": ours_res["n_images"],
            "n_gt": ours_res["n_gt"], "ours_summary": ours_res["summary"],
            "baseline_summary": base_res["summary"] if base_res else None, "baseline_available": baseline is not None}


def to_markdown(name: str, res: dict[str, Any], prov: dict[str, Any], baseline_name: str) -> str:
    def f(v: float | None) -> str:
        return "—" if v is None else f"{v:.3f}"

    lines = [f"# Domain gap: {baseline_name} vs SAMAAN on {name} test street {res['test_streets']}", "",
             f"{res['n_images']} images, {res['n_gt']} boxes · git {prov['git']} · {prov['generated_at']}", ""]
    if prov["synthetic"]:
        lines.append("**SYNTHETIC SMOKE DATA — not an evaluation result.**\n")
    if not res["baseline_available"]:
        lines.append("Baseline weights not configured (config/domain_gap.yaml): only our model is reported.\n")
    lines += ["| class | GT | baseline P | baseline R | baseline AP50 | ours P | ours R | ours AP50 |",
              "|---|---|---|---|---|---|---|---|"]
    for r in res["rows"]:
        bp = "not in baseline" if not r["in_baseline"] else f(r["baseline_precision"])
        br = "" if not r["in_baseline"] else f(r["baseline_recall"])
        ba = "" if not r["in_baseline"] else f(r["baseline_ap50"])
        lines.append(f"| {r['class']} | {r['n_gt']} | {bp} | {br} | {ba} | {f(r['ours_precision'])} | {f(r['ours_recall'])} | {f(r['ours_ap50'])} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", required=True)
    ap.add_argument("--ours", required=True)
    ap.add_argument("--baseline", default=None, help="override baseline weights from config/domain_gap.yaml")
    ap.add_argument("--baseline-map", type=Path, default=ROOT / "config" / "domain_gap.yaml")
    ap.add_argument("--device", default="")
    ap.add_argument("--allow-synthetic", action="store_true")
    args = ap.parse_args()
    dg = yaml.safe_load(args.baseline_map.read_text())["baseline"]
    baseline = args.baseline or dg.get("weights")
    res = compare(args.name, args.ours, baseline, dict(dg.get("class_map") or {}), args.device)
    prov = provenance(args.name, args.ours, {"baseline": baseline, "baseline_name": dg.get("name")})
    out_dir = results_dir_for(args.name, args.allow_synthetic)
    base = out_dir / f"domain_gap_{args.name}"
    base.with_suffix(".json").write_text(json.dumps({**prov, **res}, indent=2, default=str))
    md = to_markdown(args.name, res, prov, dg.get("name") or "baseline")
    base.with_suffix(".md").write_text(md)
    print(md)
    print("written", base.with_suffix(".md"))


if __name__ == "__main__":
    main()
