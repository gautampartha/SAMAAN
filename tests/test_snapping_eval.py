"""eval/snapping_eval.py on a toy DB: accuracy bookkeeping and the synthetic guard."""
from __future__ import annotations

import pytest
from sqlmodel import Session, select

from api.models import Detection, FootpathEdge, Image
from eval.snapping_eval import evaluate, read_ground_truth, to_markdown
from tests.test_geolocate import PIPE, _toy_db, geolocate_all  # reuse the toy road


def test_snapping_eval_counts(tmp_path):
    engine = _toy_db(tmp_path)
    with Session(engine) as s:
        from datetime import UTC, datetime

        from common.crs import xy_to_lonlat
        from tests.test_geolocate import X0, Y0

        lon, lat = xy_to_lonlat(X0 + 100, Y0 + 4.5)
        im = Image(source="own", lat=lat, lon=lon, heading_deg=150.0, hfov_deg=90.0, width=1000, height=1000,
                   gps_accuracy_m=4.0, captured_at=datetime(2026, 10, 24, tzinfo=UTC), session_id="walk-L", synthetic=False)
        s.add(im); s.flush()
        s.add(Detection(image_id=im.id, class_id="steps_or_high_kerb", score=0.8, x1=500, y1=0, x2=600, y2=590,
                        image_w=1000, image_h=1000, synthetic=False))
        s.commit()
        geolocate_all(s, PIPE)
        right = next(e for e in s.exec(select(FootpathEdge)).all() if e.side == "R")
        gt_path = tmp_path / "snapping.csv"
        gt_path.write_text("image_id,class_id,true_edge_id,true_side,note\n"
                           f"{im.id},steps_or_high_kerb,{right.id},R,across the road\n"
                           f"{im.id},open_drain,{right.id},R,no detection for this one\n")
        res = evaluate(s, read_ground_truth(gt_path))
        assert res["n_ground_truth"] == 2 and res["n_evaluated"] == 1 and res["n_without_detection"] == 1
        assert res["ours"]["edge_accuracy"] == 1.0 and res["ours"]["side_accuracy"] == 1.0
        assert res["naive"]["edge_accuracy"] == 0.0 and res["naive"]["side_accuracy"] == 0.0
        md = to_markdown(res, "toy", "abc")
        assert "SAMAAN side-aware | 100.0%" in md and "naive" in md
        # synthetic image in the ground truth -> refuse
        fake = Image(source="own", lat=lat, lon=lon, hfov_deg=90.0, synthetic=True)
        s.add(fake); s.commit()
        gt_path.write_text(f"image_id,class_id,true_edge_id,true_side\n{fake.id},open_drain,{right.id},R\n")
        with pytest.raises(RuntimeError):
            evaluate(s, read_ground_truth(gt_path))
