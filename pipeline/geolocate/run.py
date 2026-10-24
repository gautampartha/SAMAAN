"""`make geolocate`: detections -> located + snapped -> barriers -> segment states."""
from __future__ import annotations

import argparse
import logging

from sqlmodel import Session

from api.db import init_db
from pipeline.geolocate.barriers import build_barriers
from pipeline.geolocate.geolocate import geolocate_all
from pipeline.state.recompute import recompute_states

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default=None, help="only detections from this model/run name")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    with Session(init_db()) as session:
        print("geolocate:", geolocate_all(session, model=args.model))
        print("barriers:", build_barriers(session))
        print("states:", recompute_states(session))
