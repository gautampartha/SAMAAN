# Training the detector on another machine (GPU hand-off)

The rest of SAMAAN does not need trained weights: routing, reach, reports and rides run from the
barrier table, which the synthetic seed fills until real detections exist. Train whenever the
labels are ready, on any machine with a GPU, then bring the weights back.

## Prerequisites on the GPU machine (checklist)
- NVIDIA GPU with a current driver (`nvidia-smi` works; CUDA 12 capable, ≥ 4 GB VRAM is enough
  for YOLO11n/s at 640 px), **or** an Apple Silicon Mac (MPS).
- Git, **Python 3.11** (the project pins `>=3.11,<3.12`), **uv** (`pip install uv`). `make` is
  optional; on Windows run the `python -m …` commands with the venv activated.
- ~6 GB free disk (CUDA PyTorch ≈ 3 GB + dataset), internet on first run (dependencies, the CUDA
  wheel, the 5 MB base weights Ultralytics downloads).
- The labelled dataset folder **with images** (gitignored, so copy it separately; see below).
- Not needed there: Node, the SQLite DB, the OSM download, a Mapillary token. Inference and
  evaluation against the zone run on the demo laptop afterwards.

## What to copy to the GPU machine
1. The repo (clone or zip; `git clone` is enough).
2. The labelled dataset folder **including images** (images are gitignored):
   `data/labels/<name>/` with `images/`, `labels/`, `manifest.csv`, `splits.json`, `data.yaml`,
   `train.txt`, `val.txt`, `test.txt`. Zip it: `zip -r karkarduma_v1.zip data/labels/karkarduma_v1`.
   `data.yaml` holds an absolute `path:`; re-run `python -m ml.dataset split --name <name>
   --test-street <same street as in splits.json>` on the GPU machine to rewrite it.

## On the GPU machine
```bash
uv venv .venv --python 3.11 && uv pip install --python .venv/bin/python -e ".[dev]"
# NVIDIA on Linux/Windows: replace the CPU torch that pip installs
uv pip install --python .venv/bin/python torch torchvision --index-url https://download.pytorch.org/whl/cu121
.venv/bin/python -c "import torch; print(torch.cuda.is_available())"   # must print True
# Apple Silicon: torch from PyPI already supports MPS; set device: "mps" in config/train.yaml
.venv/bin/python -m ml.dataset split --name karkarduma_v1 --test-street <street>
make train NAME=karkarduma_v1                      # ~60 epochs, yolo11n; set model: yolo11s.pt for more accuracy
make eval NAME=karkarduma_v1 WEIGHTS=ml/runs/karkarduma_v1/weights/best.pt
python -m ml.domain_gap --name karkarduma_v1 --ours ml/runs/karkarduma_v1/weights/best.pt   # once config/domain_gap.yaml has a baseline
```
Edit `config/train.yaml` (`epochs`, `batch`, `imgsz`, `device`) rather than passing flags, so the
settings are recorded. On Windows use `python -m ...` with the venv activated instead of `make`.

## What to bring back
- `ml/runs/karkarduma_v1/weights/best.pt` (and `samaan_train_meta.json`): copy into the same path
  on the demo laptop (weights are gitignored; share via drive/USB).
- `eval/results/detector_karkarduma_v1_ours.{json,md}` and `domain_gap_karkarduma_v1.*`: commit
  them; they are the pitch numbers.

## Back on the demo laptop
```bash
make infer WEIGHTS=ml/runs/karkarduma_v1/weights/best.pt   # detections for all stored zone images
make geolocate                                             # detections -> barriers on the right edge/side
make coverage                                              # states from real coverage + barriers
python -m eval.snapping_eval                                # needs data/ground_truth/snapping.csv
```
Real barriers then replace the seeded ones on the map and in routing.
