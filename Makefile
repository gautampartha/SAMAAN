# SAMAAN - Walk for All
# Usage: make setup && make seed && make test && make api
PY      := .venv/bin/python
UV      := uv
DB      := data/processed/samaan.sqlite

.PHONY: setup seed graph api test lint web web-install clean-db help

help:
	@echo "make setup        create .venv (Python 3.11) and install deps"
	@echo "make graph        download OSM for the zone and build the P0 graph (cached)"
	@echo "make seed         graph + synthetic barriers/coverage into $(DB)  [synthetic=true]"
	@echo "make api          serve FastAPI on http://127.0.0.1:8000 (docs at /docs)"
	@echo "make test         run pytest"
	@echo "make web-install  npm install in web/"
	@echo "make web          Vite dev server for the PWA (http://127.0.0.1:5173)"

setup:
	$(UV) venv .venv --python 3.11
	$(UV) pip install --python $(PY) -e ".[dev]"

graph:
	$(PY) -m pipeline.graph.build

seed: graph
	$(PY) -m pipeline.seed.synthetic

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
