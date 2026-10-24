# SAMAAN - Walk for All
# Usage: make setup && make seed && make test && make api
PY      := .venv/bin/python
UV      := uv
DB      := data/processed/samaan.sqlite

.PHONY: setup seed graph graph-export graph-import graph-validate coverage ingest-mapillary ml-smoke train eval infer geolocate snapping-eval missions export-active ride-calibration api test lint web web-install clean-db help

help:
	@echo "make setup        create .venv (Python 3.11) and install deps"
	@echo "make graph        download OSM (cached) and synthesise the footpath graph into $(DB)"
	@echo "make graph-export export the graph to data/processed/footpath_graph.geojson for QGIS/JOSM"
	@echo "make graph-import FILE=path.geojson   load a human-corrected graph (then make seed)"
	@echo "make graph-validate                   print the validation report"
	@echo "make seed         synthetic barriers/coverage into $(DB) (builds the graph if missing) [synthetic=true]"
	@echo "make ingest-mapillary   MAPILLARY_TOKEN=... download zone images (add DOWNLOAD=1 for thumbnails)"
	@echo "make coverage     recompute image coverage + segment states"
	@echo "make ml-smoke     synthetic end-to-end check of split/train/eval/domain-gap/infer (never eval/results)"
	@echo "make train NAME=<dataset> [EPOCHS=60]     train YOLO on data/labels/<dataset>"
	@echo "make eval NAME=<dataset> WEIGHTS=path.pt   per-class P/R on the held-out street -> eval/results/"
	@echo "make infer WEIGHTS=path.pt                 detections for all stored zone images"
	@echo "make geolocate    detections -> located, side-aware snapped, clustered into barriers, states"
	@echo "make snapping-eval   ours vs naive snapper against data/ground_truth/snapping.csv -> eval/results/"
	@echo "make missions     sample OD pairs, score unknown stretches, store the top missions"
	@echo "make export-active   verified report photos -> YOLO dataset data/labels/active_<date>/"
	@echo "make api          serve FastAPI on http://127.0.0.1:8000 (docs at /docs)"
	@echo "make test         run pytest"
	@echo "make web-install  npm install in web/"
	@echo "make web          Vite dev server for the PWA (http://127.0.0.1:5173)"

setup:
	$(UV) venv .venv --python 3.11
	$(UV) pip install --python $(PY) -e ".[dev]"

graph:
	$(PY) -m pipeline.graph.build
	$(PY) -m pipeline.graph.validate

graph-export:
	$(PY) -m pipeline.graph.export

graph-import:
	$(PY) -m pipeline.graph.import_corrected $(FILE)

graph-validate:
	$(PY) -m pipeline.graph.validate

seed:
	@test -f $(DB) || $(MAKE) graph
	$(PY) -m pipeline.seed.synthetic

ingest-mapillary:
	$(PY) -m pipeline.ingest.mapillary $(if $(DOWNLOAD),--download,) $(if $(MAX),--max $(MAX),)

coverage:
	$(PY) -m pipeline.coverage.run

ml-smoke:
	$(PY) -m ml.smoke_dataset --name smoke --n 24
	$(PY) -m ml.dataset import data/labels/smoke_export --name smoke --synthetic
	$(PY) -m ml.dataset split --name smoke --test-street gamma-lane
	$(PY) -m ml.train --name smoke --run-name smoke --epochs 2 --imgsz 160 --batch 8 --device cpu
	$(PY) -m ml.eval --name smoke --weights ml/runs/smoke/weights/best.pt --allow-synthetic --device cpu
	$(PY) -m ml.domain_gap --name smoke --ours ml/runs/smoke/weights/best.pt --allow-synthetic --device cpu
	@echo "smoke results are in data/processed/smoke_results/ (synthetic; NOT eval/results)"

train:
	$(PY) -m ml.train --name $(NAME) $(if $(EPOCHS),--epochs $(EPOCHS),)

eval:
	$(PY) -m ml.eval --name $(NAME) --weights $(WEIGHTS)

infer:
	$(PY) -m ml.infer --weights $(WEIGHTS)

geolocate:
	$(PY) -m pipeline.geolocate.run

snapping-eval:
	$(PY) -m eval.snapping_eval

missions:
	$(PY) -c "from sqlmodel import Session; from api.db import init_db; from pipeline.missions.compute import compute_missions; print(compute_missions(Session(init_db())))"

export-active:
	$(PY) -m ml.export_active_learning

ride-calibration:
	$(PY) -m eval.ride_calibration

api:
	$(PY) -m uvicorn api.main:app --host 127.0.0.1 --port 8000 --reload

test:
	$(PY) -m pytest

lint:
	$(PY) -m ruff check .

web-install:
	cd web && npm install

web:
	cd web && npm run dev

clean-db:
	rm -f $(DB)
