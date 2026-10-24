"""Active learning export (plan 6.8 step 7): verified citizen-report photos -> YOLO dataset.

    python -m ml.export_active_learning [--name active_YYYYMMDD]

Each verified report with a photo becomes one image + label line. The box is the detector's
prescreen box when it matched the reported class; otherwise a centred weak box covering the
middle 60 % of the frame, flagged `needs_box_review` in manifest.csv so a human tightens it
before training. Nothing synthetic is exported.
"""
from __future__ import annotations

import argparse
import csv
import shutil
from datetime import UTC, datetime

from sqlmodel import Session, select

from api.db import init_db
from api.models import Image, Report
from common import config
from common.paths import ROOT
from ml.dataset import LABELS_ROOT


def export(session: Session, name: str) -> dict[str, int]:
    tax = {c["id"]: c["yolo_index"] for c in config.taxonomy()["detector_classes"]}
    out = LABELS_ROOT / name
    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "labels").mkdir(parents=True, exist_ok=True)
    rows, n_weak, n_skipped = [], 0, 0
    for r in session.exec(select(Report).where(Report.status == "verified", Report.kind == "barrier")).all():
        if r.synthetic or r.class_id not in tax or not r.photo_image_id:
            n_skipped += 1
            continue
        img = session.get(Image, r.photo_image_id)
        if img is None or not img.path or not (ROOT / img.path).exists():
            n_skipped += 1
            continue
        src = ROOT / img.path
        stem = f"report-{r.id}"
        shutil.copy2(src, out / "images" / f"{stem}{src.suffix}")
        if r.prescreen_box and img.width and img.height:
            x1, y1, x2, y2 = r.prescreen_box
            cx, cy, w, h = (x1 + x2) / 2 / img.width, (y1 + y2) / 2 / img.height, (x2 - x1) / img.width, (y2 - y1) / img.height
            weak = False
        else:
            cx, cy, w, h, weak = 0.5, 0.55, 0.6, 0.6, True
            n_weak += 1
        (out / "labels" / f"{stem}.txt").write_text(f"{tax[r.class_id]} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n")
        rows.append({"file": f"images/{stem}{src.suffix}", "image_id": img.id, "source": "report", "lat": r.lat, "lon": r.lon,
                     "street": f"report:{r.edge_id}", "n_labels": 1, "synthetic": "false", "report_id": r.id,
                     "class_id": r.class_id, "severity": r.severity, "needs_box_review": str(weak).lower()})
    with (out / "manifest.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else ["file", "image_id", "source", "lat", "lon", "street", "n_labels", "synthetic", "report_id", "class_id", "severity", "needs_box_review"])
        w.writeheader()
        w.writerows(rows)
    (out / "data.yaml").write_text("names:\n" + "".join(f"  {i}: {c}\n" for c, i in sorted(tax.items(), key=lambda kv: kv[1])) + f"nc: {len(tax)}\n")
    return {"exported": len(rows), "weak_boxes": n_weak, "skipped": n_skipped,
            "dir": str(out.relative_to(ROOT)) if out.is_relative_to(ROOT) else str(out)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", default=f"active_{datetime.now(UTC):%Y%m%d}")
    args = ap.parse_args()
    with Session(init_db()) as session:
        print(export(session, args.name))


if __name__ == "__main__":
    main()
