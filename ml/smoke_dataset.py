"""Synthetic smoke dataset so the detector pipeline can be exercised end to end before any real
labels exist. Coloured shapes on noisy backgrounds, one 'street' per colour family. EVERYTHING
here is synthetic=true and must never reach eval/results/ (ml/common.results_dir_for enforces it).

    python -m ml.smoke_dataset [--name smoke] [--n 24]
"""
from __future__ import annotations

import argparse
import random
import shutil
from pathlib import Path

import yaml

from common import config
from ml.dataset import LABELS_ROOT

STREETS = ["alpha-marg", "beta-road", "gamma-lane"]


def make(name: str = "smoke", n: int = 24, size: int = 160, seed: int = 7) -> Path:
    from PIL import Image, ImageDraw

    rng = random.Random(seed)
    classes = config.taxonomy()["detector_classes"]
    export = LABELS_ROOT / f"{name}_export"
    if export.exists():
        shutil.rmtree(export)
    (export / "images").mkdir(parents=True)
    (export / "labels").mkdir(parents=True)
    palette = [(220, 40, 40), (40, 160, 60), (40, 80, 220), (230, 200, 30), (150, 50, 200), (20, 190, 190),
               (240, 120, 20), (90, 90, 90)]
    for i in range(n):
        street = STREETS[i % len(STREETS)]
        img = Image.new("RGB", (size, size), (rng.randint(150, 230),) * 3)
        d = ImageDraw.Draw(img)
        for _ in range(60):
            x, y = rng.randint(0, size - 1), rng.randint(0, size - 1)
            d.point((x, y), fill=(rng.randint(0, 255),) * 3)
        lines = []
        for _ in range(rng.randint(1, 3)):
            ci = rng.randrange(len(classes))
            w, h = rng.randint(24, 60), rng.randint(24, 60)
            x1, y1 = rng.randint(0, size - w - 1), rng.randint(0, size - h - 1)
            d.rectangle([x1, y1, x1 + w, y1 + h], fill=palette[ci], outline=(0, 0, 0))
            cx, cy = (x1 + w / 2) / size, (y1 + h / 2) / size
            lines.append(f"{ci} {cx:.6f} {cy:.6f} {w / size:.6f} {h / size:.6f}")
        stem = f"{street}-L-{i:03d}"
        img.save(export / "images" / f"{stem}.jpg", quality=90)
        (export / "labels" / f"{stem}.txt").write_text("\n".join(lines) + "\n")
    (export / "data.yaml").write_text(yaml.safe_dump({"names": [c["id"] for c in classes], "nc": len(classes)}))
    return export


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", default="smoke")
    ap.add_argument("--n", type=int, default=24)
    args = ap.parse_args()
    print("export:", make(args.name, args.n))
