# eval/results — every number used in the pitch comes from here

Files are written only by scripts in `ml/` and `eval/` running on **real** data. Each JSON
carries `dataset`, `weights`, `git` commit and `generated_at`. Synthetic datasets are refused
(`ml/common.results_dir_for`) and land in `data/processed/smoke_results/` instead.

Expected files after the human labelling task:
- `detector_<dataset>_ours.{json,md}`: per-class precision / recall / AP50 on the held-out street.
- `domain_gap_<dataset>.{json,md}`: non-Indian baseline vs ours on the same street.
Later phases add `snapping_*`, `routing_*`, `reach_*`, `ride_*`.
