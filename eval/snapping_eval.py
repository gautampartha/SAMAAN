"""Snapping accuracy, ours vs the naive baseline (plan 6.4 step 8, plan 8).

Ground truth: data/ground_truth/snapping.csv with columns
    image_id,class_id,true_edge_id,true_side[,note]
recorded by a human on site (~100 barriers). For each row the highest-score real detection of
that class in that image is compared: edge correct? side correct? for the side-aware snapper and
the naive nearest-edge-to-camera snapper. Writes eval/results/snapping_<tag>.{json,md}.
Refuses to run on synthetic images/detections (rule 11.2).
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from api.db import init_db
from api.models import Detection, FootpathEdge, Image
from common.paths import GROUND_TRUTH_DIR, ROOT

RESULTS_DIR = ROOT / "eval" / "results"


def read_ground_truth(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        r["image_id"] = int(r["image_id"])
        r["true_edge_id"] = int(r["true_edge_id"])
        r["true_side"] = (r.get("true_side") or "none").strip()
    return rows


def evaluate(session: Session, gt: list[dict[str, Any]]) -> dict[str, Any]:
    edges = {e.id: e for e in session.exec(select(FootpathEdge)).all()}
    per_row = []
    ours_edge = ours_side = naive_edge = naive_side = 0
    missing = 0
    for r in gt:
        img = session.get(Image, r["image_id"])
        if img is None or img.synthetic:
            raise RuntimeError(f"ground truth row refers to a missing or synthetic image {r['image_id']}")
        dets = [d for d in session.exec(select(Detection).where(Detection.image_id == r["image_id"],
                                                                Detection.class_id == r["class_id"])).all()
                if not d.synthetic]
        if not dets:
            missing += 1
            per_row.append({**r, "detection_id": None, "ours_edge": None, "naive_edge": None})
            continue
        d = max(dets, key=lambda x: x.score)
        o_edge_ok = d.assigned_edge_id == r["true_edge_id"]
        n_edge_ok = d.naive_edge_id == r["true_edge_id"]
        o_side = edges[d.assigned_edge_id].side if d.assigned_edge_id in edges else None
        n_side = edges[d.naive_edge_id].side if d.naive_edge_id in edges else None
        o_side_ok = o_side == r["true_side"]
        n_side_ok = n_side == r["true_side"]
        ours_edge += int(o_edge_ok)
        ours_side += int(o_side_ok)
        naive_edge += int(n_edge_ok)
        naive_side += int(n_side_ok)
        per_row.append({**r, "detection_id": d.id, "ours_edge": d.assigned_edge_id, "ours_side": o_side,
                        "ours_edge_ok": o_edge_ok, "ours_side_ok": o_side_ok, "naive_edge": d.naive_edge_id,
                        "naive_side": n_side, "naive_edge_ok": n_edge_ok, "naive_side_ok": n_side_ok,
                        "snap_confidence": d.snap_confidence})
    n = len(gt) - missing
    def acc(k: int) -> float | None:
        return round(k / n, 4) if n else None
    return {"n_ground_truth": len(gt), "n_evaluated": n, "n_without_detection": missing,
            "ours": {"edge_accuracy": acc(ours_edge), "side_accuracy": acc(ours_side), "edge_correct": ours_edge, "side_correct": ours_side},
            "naive": {"edge_accuracy": acc(naive_edge), "side_accuracy": acc(naive_side), "edge_correct": naive_edge, "side_correct": naive_side},
            "rows": per_row}


def to_markdown(res: dict[str, Any], tag: str, git: str) -> str:
    o, nv = res["ours"], res["naive"]
    f = lambda v: "—" if v is None else f"{v:.1%}"
    return "\n".join([
        f"# Snapping accuracy ({tag})", "",
        (f"{res['n_evaluated']} of {res['n_ground_truth']} ground-truth barriers had a detection "
        f"({res['n_without_detection']} without) · git {git} · {datetime.now(UTC).isoformat()}"), "",
        "| snapper | correct edge | correct side |", "|---|---|---|",
        f"| naive (nearest edge to camera, side ignored) | {f(nv['edge_accuracy'])} ({nv['edge_correct']}) | {f(nv['side_accuracy'])} ({nv['side_correct']}) |",
        f"| SAMAAN side-aware | {f(o['edge_accuracy'])} ({o['edge_correct']}) | {f(o['side_accuracy'])} ({o['side_correct']}) |", "",
    ])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gt", type=Path, default=GROUND_TRUTH_DIR / "snapping.csv")
    ap.add_argument("--tag", default="karkarduma")
    args = ap.parse_args()
    if not args.gt.exists():
        raise SystemExit(f"{args.gt} missing: record ground truth first (docs/PROGRESS.md human tasks)")
    gt = read_ground_truth(args.gt)
    with Session(init_db()) as session:
        res = evaluate(session, gt)
    git = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / f"snapping_{args.tag}.json").write_text(json.dumps({"git": git, "ground_truth": str(args.gt), **res}, indent=2, default=str))
    md = to_markdown(res, args.tag, git)
    (RESULTS_DIR / f"snapping_{args.tag}.md").write_text(md)
    print(md)


if __name__ == "__main__":
    main()
