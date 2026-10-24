"""`make coverage`: recompute image coverage and segment states."""
from __future__ import annotations

import logging

from sqlmodel import Session

from api.db import init_db
from pipeline.coverage.compute import compute_coverage
from pipeline.state.expire import expire_temporary_barriers
from pipeline.state.recompute import recompute_states

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    with Session(init_db()) as session:
        print("expired:", expire_temporary_barriers(session))
        print("coverage:", compute_coverage(session))
        print("states:", recompute_states(session))
