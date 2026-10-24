"""init_db adds columns that newer models introduce to an older SQLite file."""
from __future__ import annotations

import sqlite3

from sqlalchemy import inspect

from api.db import add_missing_columns, get_engine, init_db


def test_add_missing_columns(tmp_path):
    path = tmp_path / "old.sqlite"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE image (id INTEGER PRIMARY KEY, source TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, hfov_deg REAL NOT NULL, synthetic BOOLEAN NOT NULL)")
    con.execute("INSERT INTO image (source, lat, lon, hfov_deg, synthetic) VALUES ('own', 28.6, 77.3, 65, 0)")
    con.commit()
    con.close()
    engine = init_db(path)
    cols = {c["name"] for c in inspect(engine).get_columns("image")}
    assert {"sequence_id", "camera_type", "session_id", "heading_source", "url", "path", "attribution"} <= cols
    assert add_missing_columns(get_engine(path)) == []  # idempotent
    with engine.connect() as conn:
        from sqlalchemy import text

        row = conn.execute(text("SELECT source, session_id FROM image")).one()
        assert row == ("own", None)
