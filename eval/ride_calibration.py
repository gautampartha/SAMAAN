"""Ride calibration (plan 6.10): pick the smooth-RMS and jolt-peak thresholds from labelled
calibration rides and plot the window distributions. [MEASURE]

Ground truth: data/ground_truth/ride_calibration.csv with columns
    ride_id,t_start,t_end,label        label ∈ smooth | broken | kerb
recorded while riding a known smooth stretch, a known broken stretch and over a known kerb.
Writes eval/results/ride_calibration.{json,md,png}. Refuses synthetic rides.
"""
from __future__ import annotations

import argparse
import csv
import json
import statistics
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from api.db import init_db
from api.models import Ride, RideSample
from common import config
from common.paths import GROUND_TRUTH_DIR, ROOT
from pipeline.ride.process import Sample, make_windows

RESULTS_DIR = ROOT / "eval" / "results"


def pct(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    k = min(len(s) - 1, max(0, round(q * (len(s) - 1))))
    return s[k]


def labelled_windows(session: Session, rows: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, list[tuple[float, float]]]:
    out: dict[str, list[tuple[float, float]]] = {"smooth": [], "broken": [], "kerb": []}
    by_ride: dict[int, list[dict[str, Any]]] = {}
    for r in rows:
        by_ride.setdefault(int(r["ride_id"]), []).append(r)
    for ride_id, segs in by_ride.items():
        ride = session.get(Ride, ride_id)
        if ride is None or ride.synthetic:
            raise RuntimeError(f"ride {ride_id} missing or synthetic: calibration needs real rides")
        samples = [Sample(s.t, s.ax, s.ay, s.az, s.lat, s.lon, s.gps_accuracy_m, s.speed_m_s)
                   for s in session.exec(select(RideSample).where(RideSample.ride_id == ride_id).order_by(RideSample.t)).all()]
        windows = make_windows(samples, cfg)
        for seg in segs:
            t0, t1, label = float(seg["t_start"]), float(seg["t_end"]), seg["label"].strip()
            if label not in out:
                raise ValueError(f"unknown label {label!r}")
            out[label] += [(w.rms, w.peak) for w in windows if w.t0 >= t0 and w.t1 <= t1]
    return out


def pick_thresholds(lw: dict[str, list[tuple[float, float]]]) -> dict[str, Any]:
    smooth_rms = [r for r, _ in lw["smooth"]]
    broken_rms = [r for r, _ in lw["broken"]]
    smooth_peak = [p for _, p in lw["smooth"] + lw["broken"]]
    kerb_peak = [p for _, p in lw["kerb"]]
    res: dict[str, Any] = {"n_windows": {k: len(v) for k, v in lw.items()}}
    if smooth_rms and broken_rms:
        hi_s, lo_b = pct(smooth_rms, 0.95), pct(broken_rms, 0.05)
        res["smooth_rms_threshold_m_s2"] = round((hi_s + lo_b) / 2, 3)
        res["smooth_rms_p95"], res["broken_rms_p05"] = round(hi_s, 3), round(lo_b, 3)
        res["rms_separable"] = hi_s < lo_b
    if smooth_peak and kerb_peak:
        hi_sp, lo_k = pct(smooth_peak, 0.99), pct(kerb_peak, 0.10)
        res["jolt_peak_threshold_m_s2"] = round((hi_sp + lo_k) / 2, 3)
        res["nonkerb_peak_p99"], res["kerb_peak_p10"] = round(hi_sp, 3), round(lo_k, 3)
        res["peak_separable"] = hi_sp < lo_k
    for k, v in lw.items():
        if v:
            res[f"{k}_rms_median"] = round(statistics.median(r for r, _ in v), 3)
            res[f"{k}_peak_median"] = round(statistics.median(p for _, p in v), 3)
    return res


def plot(lw: dict[str, list[tuple[float, float]]], out: Path) -> bool:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:  # noqa: BLE001
        return False
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    for label, vals in lw.items():
        if not vals:
            continue
        axes[0].hist([r for r, _ in vals], bins=30, alpha=0.5, label=label)
        axes[1].hist([p for _, p in vals], bins=30, alpha=0.5, label=label)
    axes[0].set_title("window RMS (m/s²)"); axes[1].set_title("window peak (m/s²)")
    for ax in axes:
        ax.legend()
    fig.tight_layout()
    fig.savefig(out, dpi=120)
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gt", type=Path, default=GROUND_TRUTH_DIR / "ride_calibration.csv")
    args = ap.parse_args()
    if not args.gt.exists():
        raise SystemExit(f"{args.gt} missing: record calibration rides first (docs/PROGRESS.md human tasks)")
    with args.gt.open(encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if r.get("ride_id") and not r["ride_id"].startswith("#")]
    cfg = config.pipeline()["ride"]
    with Session(init_db()) as session:
        lw = labelled_windows(session, rows, cfg)
    res = pick_thresholds(lw)
    res["generated_at"] = datetime.now(UTC).isoformat()
    res["current_config"] = {"smooth_rms_threshold_m_s2": cfg["smooth_rms_threshold_m_s2"], "jolt_peak_threshold_m_s2": cfg["jolt_peak_threshold_m_s2"]}
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / "ride_calibration.json").write_text(json.dumps(res, indent=2))
    plotted = plot(lw, RESULTS_DIR / "ride_calibration.png")
    md = ["# Ride calibration", "", f"Windows: {res['n_windows']}", ""]
    for k in ("smooth_rms_threshold_m_s2", "jolt_peak_threshold_m_s2"):
        if k in res:
            md.append(f"- Suggested `{k}`: **{res[k]}** (current config {res['current_config'][k]})")
    md.append(f"- RMS separable: {res.get('rms_separable')} · peak separable: {res.get('peak_separable')}")
    md.append(f"- Plot: {'ride_calibration.png' if plotted else 'matplotlib unavailable'}")
    (RESULTS_DIR / "ride_calibration.md").write_text("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
