"""IoU matching, per-class P/R and AP50 on toy boxes (plan 8 numbers depend on this)."""
from __future__ import annotations

from ml.metrics import (
    GT,
    Det,
    average_precision,
    iou,
    markdown_table,
    match_image,
    per_class_metrics,
    summarize,
)


def test_iou():
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0
    assert abs(iou((0, 0, 10, 10), (5, 0, 15, 10)) - 1 / 3) < 1e-9
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0


def test_greedy_match_prefers_higher_confidence_and_same_class():
    gts = [GT("steps_or_high_kerb", (0, 0, 10, 10)), GT("parked_vehicle", (50, 50, 60, 60))]
    dets = [Det("steps_or_high_kerb", 0.4, (1, 1, 10, 10)), Det("steps_or_high_kerb", 0.9, (0, 0, 9, 9)),
            Det("parked_vehicle", 0.8, (0, 0, 10, 10)),  # right box, wrong class -> FP
            Det("parked_vehicle", 0.7, (51, 51, 60, 60))]
    matched, n_gt = match_image(dets, gts, 0.5)
    assert n_gt == 2
    by_conf = {d.conf: tp for d, tp in matched}
    assert by_conf[0.9] is True and by_conf[0.4] is False  # second detection of the same GT is a FP
    assert by_conf[0.8] is False and by_conf[0.7] is True


def test_average_precision_perfect_and_half():
    assert average_precision([(0.9, True), (0.8, True)], 2) == 1.0
    assert abs(average_precision([(0.9, True), (0.8, False)], 2) - 0.5) < 1e-9
    assert average_precision([], 3) == 0.0
    assert average_precision([(0.9, False)], 0) == 0.0


def test_per_class_metrics_and_none_for_absent_classes():
    classes = ["curb_ramp", "steps_or_high_kerb", "open_drain"]
    images = [
        ([Det("curb_ramp", 0.9, (0, 0, 10, 10)), Det("curb_ramp", 0.3, (100, 100, 110, 110)),  # TP, low-conf FP (below 0.25? no: 0.3 counts)
          Det("steps_or_high_kerb", 0.1, (20, 20, 30, 30))],                                   # below conf threshold
         [GT("curb_ramp", (0, 0, 10, 10)), GT("steps_or_high_kerb", (20, 20, 30, 30))]),
        ([], [GT("curb_ramp", (0, 0, 10, 10))]),
    ]
    m = per_class_metrics(images, classes, conf_thr=0.25, iou_thr=0.5)
    assert m["curb_ramp"]["n_gt"] == 2 and m["curb_ramp"]["tp"] == 1 and m["curb_ramp"]["fp"] == 1 and m["curb_ramp"]["fn"] == 1
    assert m["curb_ramp"]["precision"] == 0.5 and m["curb_ramp"]["recall"] == 0.5
    assert m["steps_or_high_kerb"]["n_pred"] == 0 and m["steps_or_high_kerb"]["precision"] is None
    assert m["steps_or_high_kerb"]["recall"] == 0.0  # GT exists, nothing above threshold
    assert m["steps_or_high_kerb"]["ap50"] == 1.0    # but the 0.1 detection was correct, so AP is perfect
    assert m["open_drain"]["precision"] is None and m["open_drain"]["recall"] is None and m["open_drain"]["ap50"] is None
    s = summarize(m)
    assert s["classes_with_gt"] == 2 and abs(s["map50"] - 0.75) < 1e-9
    table = markdown_table(m, "t")
    assert "| open_drain | 0 | 0 | 0 | 0 | 0 | — | — | — |" in table
