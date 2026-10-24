"""Detector dataset import and street-based split (plan 6.3).

    python -m ml.dataset import <yolo_export_dir> --name karkarduma_v1 [--synthetic]
    python -m ml.dataset split --name karkarduma_v1 [--test-street NAME] [--val-fraction 0.15]

Layout under data/labels/<name>/: images/ (gitignored), labels/ (YOLO txt, committed),
manifest.csv, splits.json, data.yaml (Ultralytics), train.txt / val.txt / test.txt.
Street per image: capture session id prefix (own photos), Mapillary sequence, or the nearest
named OSM road from the footpath graph; else "unknown".
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import random
import re
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml

from common import config
from common.paths import DATA_DIR, ROOT

log = logging.getLogger(__name__)
LABELS_ROOT = DATA_DIR / "labels"
MANIFEST_FIELDS = ["file", "image_id", "source", "lat", "lon", "street", "n_labels", "synthetic"]
_SEV_SUFFIX = re.compile(r"^(?P<cls>.+?)[_-](?P<sev>[1-5])$")


def dataset_dir(name: str) -> Path:
    return LABELS_ROOT / name


def class_lookup(tax: dict[str, Any] | None = None) -> dict[str, str]:
    """Any export class name (id, alias, Project Sidewalk name, case-insensitive) -> taxonomy id."""
    tax = tax or config.taxonomy()
    lut: dict[str, str] = {}
    for c in tax["detector_classes"]:
        names = {c["id"], c["id"].replace("_", " "), c["name"]["en"], str(c.get("sidewalk_equivalent") or "")}
        names |= set(c.get("aliases", []))
        for n in names:
            if n:
                lut.setdefault(n.lower().strip(), c["id"])  # first class keeps a shared name (SurfaceProblem)
    return lut


def read_export_names(export_dir: Path) -> list[str]:
    for cand in ("data.yaml", "dataset.yaml", "classes.txt", "obj.names"):
        p = export_dir / cand
        if p.exists():
            if p.suffix == ".yaml":
                names = yaml.safe_load(p.read_text())["names"]
                return list(names.values()) if isinstance(names, dict) else list(names)
            return [line.strip() for line in p.read_text().splitlines() if line.strip()]
    raise FileNotFoundError(f"no data.yaml / classes.txt in {export_dir}")


def _find_pairs(export_dir: Path) -> list[tuple[Path, Path | None]]:
    """(image, label) pairs from Roboflow/CVAT layouts: {train,valid,test}/images|labels or flat."""
    images: list[Path] = []
    for p in export_dir.rglob("*"):
        if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp") and "images" in p.parts[-3:]:
            images.append(p)
    if not images:
        images = [p for p in export_dir.rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    pairs = []
    for img in sorted(images):
        lbl = Path(str(img.parent).replace("images", "labels")) / (img.stem + ".txt")
        if not lbl.exists():
            lbl = img.with_suffix(".txt")
        pairs.append((img, lbl if lbl.exists() else None))
    return pairs


def _lookup_image_row(stem: str) -> dict[str, Any] | None:
    """Match an export filename to the image table: own uploads are <id>.jpg, Mapillary <source_id>.jpg."""
    try:
        from sqlmodel import Session, select

        from api.db import get_engine
        from api.models import Image
    except Exception:  # noqa: BLE001  # pragma: no cover
        return None
    try:
        with Session(get_engine()) as s:
            row = None
            if stem.isdigit():
                row = s.get(Image, int(stem)) if int(stem) < 10**9 else None
                if row is None:
                    row = s.exec(select(Image).where(Image.source_id == stem)).first()
            if row is None:
                return None
            return {"image_id": row.id, "source": row.source, "lat": row.lat, "lon": row.lon,
                    "session_id": row.session_id, "sequence_id": row.sequence_id}
    except Exception as exc:  # noqa: BLE001  # DB missing: still importable
        log.debug("image lookup failed: %s", exc)
        return None


def _nearest_street_name(lat: float, lon: float) -> str | None:
    try:
        from shapely import wkt
        from shapely.geometry import Point
        from sqlmodel import Session, select

        from api.db import get_engine
        from api.models import FootpathEdge
        from common.crs import lonlat_to_xy

        x, y = lonlat_to_xy(lon, lat)
        pt = Point(x, y)
        best, best_d = None, 40.0
        with Session(get_engine()) as s:
            for e in s.exec(select(FootpathEdge)).all():
                name = e.osm_tags.get("name")
                if not name:
                    continue
                d = wkt.loads(e.geom_m_wkt).distance(pt)
                if d < best_d:
                    best, best_d = name, d
        return best
    except Exception:  # noqa: BLE001  # pragma: no cover
        return None


def street_for(stem: str, row: dict[str, Any] | None, street_from_name: bool = True) -> str:
    if row:
        if row.get("session_id"):
            sid = str(row["session_id"])
            return re.sub(r"[-_](L|R|left|right|both)$", "", sid, flags=re.IGNORECASE).lower()
        if row.get("sequence_id"):
            return f"seq:{row['sequence_id']}"
        name = _nearest_street_name(row["lat"], row["lon"]) if row.get("lat") is not None else None
        if name:
            return name.lower()
    if street_from_name:
        m = re.match(r"^([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z][A-Za-z0-9]*)*?)[-_](?:L|R|left|right|both)[-_]\d+$", stem)
        if m:
            return m.group(1).lower().replace("_", "-")
        m = re.match(r"^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9]*)+)[-_]\d+$", stem)
        if m:
            return m.group(1).lower()
    return "unknown"


def convert_label_file(src: Path | None, names: list[str], lut: dict[str, str], tax_index: dict[str, int]) -> tuple[list[str], dict[str, int], int]:
    """Rewrite export class indices to taxonomy indices; strip severity suffixes into a side file."""
    lines, sev_counts, dropped = [], defaultdict(int), 0
    if src is None:
        return lines, sev_counts, dropped
    for raw in src.read_text().splitlines():
        parts = raw.split()
        if len(parts) < 5:
            continue
        name = names[int(parts[0])] if int(parts[0]) < len(names) else str(parts[0])
        sev = None
        m = _SEV_SUFFIX.match(name)
        if m and m.group("cls").lower() in lut:
            name, sev = m.group("cls"), int(m.group("sev"))
        cid = lut.get(name.lower().strip())
        if cid is None:
            dropped += 1
            continue
        if sev:
            sev_counts[f"{cid}:{sev}"] += 1
        lines.append(" ".join([str(tax_index[cid]), *parts[1:5]]))
    return lines, sev_counts, dropped


def import_export(export_dir: Path, name: str, synthetic: bool = False, copy_images: bool = True) -> dict[str, Any]:
    tax = config.taxonomy()
    lut = class_lookup(tax)
    tax_index = {c["id"]: c["yolo_index"] for c in tax["detector_classes"]}
    names = read_export_names(export_dir)
    unknown = [n for n in names if n.lower().strip() not in lut and not (_SEV_SUFFIX.match(n) and _SEV_SUFFIX.match(n).group("cls").lower() in lut)]
    if unknown:
        log.warning("export classes not in taxonomy (boxes dropped): %s", unknown)
    out = dataset_dir(name)
    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "labels").mkdir(parents=True, exist_ok=True)
    rows, dropped_total, matched = [], 0, 0
    sev_all: dict[str, int] = defaultdict(int)
    for img, lbl in _find_pairs(export_dir):
        stem = img.stem
        dest_img = out / "images" / img.name
        if copy_images and not dest_img.exists():
            shutil.copy2(img, dest_img)
        lines, sev, dropped = convert_label_file(lbl, names, lut, tax_index)
        dropped_total += dropped
        for k, v in sev.items():
            sev_all[k] += v
        (out / "labels" / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
        row = None if synthetic else _lookup_image_row(stem)
        matched += int(row is not None)
        rows.append({"file": f"images/{img.name}", "image_id": row["image_id"] if row else "",
                     "source": row["source"] if row else "export", "lat": row["lat"] if row else "",
                     "lon": row["lon"] if row else "", "street": street_for(stem, row),
                     "n_labels": len(lines), "synthetic": str(bool(synthetic)).lower()})
    with (out / "manifest.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=MANIFEST_FIELDS)
        w.writeheader()
        w.writerows(rows)
    if sev_all:
        (out / "severity_counts.json").write_text(json.dumps(dict(sev_all), indent=2))
    streets = defaultdict(int)
    for r in rows:
        streets[r["street"]] += r["n_labels"]
    summary = {"name": name, "images": len(rows), "boxes": sum(r["n_labels"] for r in rows), "matched_to_db": matched,
               "boxes_dropped_unknown_class": dropped_total, "streets": dict(streets), "synthetic": synthetic}
    (out / "import_summary.json").write_text(json.dumps(summary, indent=2))
    return summary


def read_manifest(name: str) -> list[dict[str, Any]]:
    with (dataset_dir(name) / "manifest.csv").open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def is_synthetic(name: str) -> bool:
    rows = read_manifest(name)
    return any(r.get("synthetic", "false").lower() == "true" for r in rows)


def split_by_street(rows: list[dict[str, Any]], test_street: str | None = None, val_fraction: float = 0.15,
                    test_target_fraction: float = 0.15, seed: int = 42) -> dict[str, Any]:
    """Whole streets go to one split. Test = one street (given, or the one whose box count is
    closest to test_target_fraction of all boxes, excluding 'unknown'). Val = random whole streets
    until ~val_fraction of the remaining boxes. Everything else = train."""
    boxes = defaultdict(int)
    for r in rows:
        boxes[r["street"]] += int(r["n_labels"] or 0)
    streets = [s for s in boxes if s != "unknown"] or list(boxes)
    if len(streets) < 2:
        raise ValueError("need at least two labelled streets for a street-based split")
    total = sum(boxes.values())
    if test_street is None:
        test_street = min(streets, key=lambda s: (abs(boxes[s] - test_target_fraction * total), s))
    if test_street not in boxes:
        raise ValueError(f"unknown test street {test_street!r}; known: {sorted(boxes)}")
    rest = [s for s in streets if s != test_street]
    rng = random.Random(seed)
    rng.shuffle(rest)
    val: list[str] = []
    target = val_fraction * (total - boxes[test_street])
    acc = 0
    for s in rest:
        if acc >= target or len(rest) - len(val) <= 1:
            break
        val.append(s)
        acc += boxes[s]
    train = [s for s in boxes if s not in val and s != test_street]  # includes 'unknown' street in train
    return {"test": [test_street], "val": sorted(val), "train": sorted(train), "boxes_by_street": dict(boxes),
            "seed": seed}


def write_split(name: str, split: dict[str, Any]) -> Path:
    out = dataset_dir(name)
    rows = read_manifest(name)
    tax = config.taxonomy()
    names = {c["yolo_index"]: c["id"] for c in tax["detector_classes"]}
    by_split = {"train": [], "val": [], "test": []}
    for r in rows:
        for k, files in by_split.items():
            if r["street"] in split[k]:
                files.append(str((out / r["file"]).resolve()))
    for k, files in by_split.items():
        (out / f"{k}.txt").write_text("\n".join(files) + ("\n" if files else ""))
    data_yaml = {"path": str(out.resolve()), "train": "train.txt", "val": "val.txt" if by_split["val"] else "train.txt",
                 "test": "test.txt", "names": {int(k): v for k, v in sorted(names.items())}}
    (out / "data.yaml").write_text(yaml.safe_dump(data_yaml, sort_keys=False))
    split_out = {**split, "counts": {k: len(v) for k, v in by_split.items()}}
    (out / "splits.json").write_text(json.dumps(split_out, indent=2))
    return out / "data.yaml"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    imp = sub.add_parser("import")
    imp.add_argument("export_dir", type=Path)
    imp.add_argument("--name", required=True)
    imp.add_argument("--synthetic", action="store_true", help="flag the dataset synthetic (never for eval)")
    sp = sub.add_parser("split")
    sp.add_argument("--name", required=True)
    sp.add_argument("--test-street", default=None)
    sp.add_argument("--val-fraction", type=float, default=0.15)
    sp.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    if args.cmd == "import":
        print(json.dumps(import_export(args.export_dir, args.name, synthetic=args.synthetic), indent=2))
    else:
        split = split_by_street(read_manifest(args.name), args.test_street, args.val_fraction, seed=args.seed)
        path = write_split(args.name, split)
        print(json.dumps(split, indent=2))
        print("wrote", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
