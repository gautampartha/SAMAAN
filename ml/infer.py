"""Batch inference (plan 6.3, last step): run the detector on every stored zone image and save
Detection rows (pixel xyxy + image size, model name, score). Real images only.

    python -m ml.infer --weights ml/runs/karkarduma_v1/weights/best.pt [--source own|mapillary] [--replace]
"""
from __future__ import annotations

import argparse
import logging
from pathlib import Path

from sqlmodel import Session, delete, select

from api.db import init_db
from api.models import Detection, Image
from common import config
from common.paths import ROOT
from ml.common import image_size, predict

log = logging.getLogger(__name__)


def run_inference(session: Session, weights: str | Path, source: str | None = None, replace: bool = False,
                  min_conf: float | None = None, device: str = "", limit: int | None = None) -> dict[str, int]:
    icfg = config.load("train")["infer"]
    min_conf = float(min_conf if min_conf is not None else icfg["min_conf"])
    model_name = Path(weights).parent.parent.name if Path(weights).name in ("best.pt", "last.pt") else Path(weights).stem
    q = select(Image).where(Image.synthetic == False)
    if source:
        q = q.where(Image.source == source)
    images = [i for i in session.exec(q).all() if i.path and (ROOT / i.path).exists()]
    if limit:
        images = images[:limit]
    if replace and images:
        session.exec(delete(Detection).where(Detection.model == model_name,  # type: ignore[arg-type]
                                             Detection.image_id.in_([i.id for i in images])))  # type: ignore[union-attr]
    already = {d.image_id for d in session.exec(select(Detection).where(Detection.model == model_name)).all()}
    todo = [i for i in images if i.id not in already]
    files = [ROOT / i.path for i in todo]
    by_file = {ROOT / i.path: i for i in todo}
    preds = predict(weights, files, min_conf, int(icfg["imgsz"]), device=device)
    n_det = 0
    for f, dets in preds.items():
        img = by_file[f]
        w, h = image_size(f)
        for d in dets:
            session.add(Detection(image_id=img.id, class_id=d.cls, score=d.conf, x1=d.box[0], y1=d.box[1], x2=d.box[2],
                                  y2=d.box[3], model=model_name, image_w=w, image_h=h, synthetic=False))
            n_det += 1
    session.commit()
    stats = {"images_with_photo": len(images), "images_processed": len(todo), "detections": n_det,
             "skipped_already_done": len(images) - len(todo)}
    log.info("inference: %s", stats)
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--source", default=None)
    ap.add_argument("--replace", action="store_true")
    ap.add_argument("--min-conf", type=float, default=None)
    ap.add_argument("--device", default="")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    with Session(init_db()) as session:
        print(run_inference(session, args.weights, args.source, args.replace, args.min_conf, args.device, args.limit))


if __name__ == "__main__":
    main()
