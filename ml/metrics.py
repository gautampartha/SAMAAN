"""Detection metrics (plan 8): per-class precision/recall at a confidence threshold and AP50,
with greedy IoU matching. Pure Python so it is unit-testable and shared by eval and domain gap.

Boxes are (x1, y1, x2, y2) in any consistent unit. A detection is (class_id, conf, box).
Ground truth is (class_id, box).
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Any

Box = tuple[float, float, float, float]


@dataclass(frozen=True)
class Det:
    cls: str
    conf: float
    box: Box


@dataclass(frozen=True)
class GT:
    cls: str
    box: Box


def iou(a: Box, b: Box) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter == 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


def match_image(dets: list[Det], gts: list[GT], iou_thr: float) -> tuple[list[tuple[Det, bool]], int]:
    """Greedy matching per class in descending confidence. Returns [(det, is_tp)] and n_gt."""
    out: list[tuple[Det, bool]] = []
    used: set[int] = set()
    for d in sorted(dets, key=lambda d: -d.conf):
        best, best_iou = -1, iou_thr
        for gi, g in enumerate(gts):
            if gi in used or g.cls != d.cls:
                continue
            v = iou(d.box, g.box)
            if v >= best_iou:
                best, best_iou = gi, v
        if best >= 0:
            used.add(best)
            out.append((d, True))
        else:
            out.append((d, False))
    return out, len(gts)


def average_precision(tps: list[tuple[float, bool]], n_gt: int) -> float:
    """AP (all-point interpolation) from (conf, is_tp) pairs for one class."""
    if n_gt == 0:
        return 0.0
    pairs = sorted(tps, key=lambda p: -p[0])
    tp = fp = 0
    precisions: list[float] = []
    recalls: list[float] = []
    for _, is_tp in pairs:
        tp += int(is_tp)
        fp += int(not is_tp)
        precisions.append(tp / (tp + fp))
        recalls.append(tp / n_gt)
    # monotone precision envelope
    for i in range(len(precisions) - 2, -1, -1):
        precisions[i] = max(precisions[i], precisions[i + 1])
    ap, prev_r = 0.0, 0.0
    for p, r in zip(precisions, recalls, strict=False):
        ap += p * (r - prev_r)
        prev_r = r
    return ap


def per_class_metrics(images: list[tuple[list[Det], list[GT]]], classes: list[str], conf_thr: float = 0.25,
                      iou_thr: float = 0.5) -> dict[str, dict[str, Any]]:
    """images: list of (detections, ground truths) per image.

    Returns {class: {n_gt, n_pred, tp, fp, fn, precision, recall, ap50}}. Precision/recall are
    at conf >= conf_thr; AP uses every detection. Classes with no GT and no predictions get None
    for precision/recall so they are never mistaken for zeros.
    """
    matched_all: dict[str, list[tuple[float, bool]]] = defaultdict(list)
    n_gt: dict[str, int] = defaultdict(int)
    for dets, gts in images:
        for g in gts:
            n_gt[g.cls] += 1
        matched, _ = match_image(dets, gts, iou_thr)
        for d, is_tp in matched:
            matched_all[d.cls].append((d.conf, is_tp))
    out: dict[str, dict[str, Any]] = {}
    for c in classes:
        pairs = matched_all.get(c, [])
        above = [p for p in pairs if p[0] >= conf_thr]
        tp = sum(1 for p in above if p[1])
        fp = len(above) - tp
        fn = n_gt[c] - tp
        prec = tp / (tp + fp) if (tp + fp) else None
        rec = tp / n_gt[c] if n_gt[c] else None
        out[c] = {"n_gt": n_gt[c], "n_pred": len(above), "tp": tp, "fp": fp, "fn": fn,
                  "precision": prec, "recall": rec,
                  "ap50": average_precision(pairs, n_gt[c]) if n_gt[c] else None}
    return out


def summarize(metrics: dict[str, dict[str, Any]]) -> dict[str, float | None]:
    vals = [m for m in metrics.values() if m["n_gt"] > 0]
    if not vals:
        return {"macro_precision": None, "macro_recall": None, "map50": None, "classes_with_gt": 0}
    precs = [m["precision"] for m in vals if m["precision"] is not None]
    return {
        "macro_precision": sum(precs) / len(precs) if precs else None,
        "macro_recall": sum(m["recall"] for m in vals) / len(vals),
        "map50": sum(m["ap50"] for m in vals) / len(vals),
        "classes_with_gt": len(vals),
    }


def markdown_table(metrics: dict[str, dict[str, Any]], title: str = "") -> str:
    def f(v: float | None) -> str:
        return "—" if v is None else f"{v:.3f}"

    lines = [f"### {title}" if title else "", "| class | GT | pred | TP | FP | FN | precision | recall | AP50 |",
             "|---|---|---|---|---|---|---|---|---|"]
    for c, m in metrics.items():
        lines.append(f"| {c} | {m['n_gt']} | {m['n_pred']} | {m['tp']} | {m['fp']} | {m['fn']} | "
                     f"{f(m['precision'])} | {f(m['recall'])} | {f(m['ap50'])} |")
    return "\n".join(line for line in lines if line is not None) + "\n"
