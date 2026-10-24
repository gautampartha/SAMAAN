from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine
from sqlmodel import Session, SQLModel, create_engine

from common.paths import db_path

_engine: Engine | None = None
_engine_path: Path | None = None


def get_engine(path: Path | None = None) -> Engine:
    """Engine for the configured SQLite file (SAMAAN_DB env or data/processed/samaan.sqlite)."""
    global _engine, _engine_path
    p = Path(path) if path else db_path()
    if _engine is None or _engine_path != p:
        p.parent.mkdir(parents=True, exist_ok=True)
        _engine = create_engine(f"sqlite:///{p}", connect_args={"check_same_thread": False})
        _engine_path = p
    return _engine


def init_db(path: Path | None = None) -> Engine:
    import api.models  # noqa: F401  (register tables)

    engine = get_engine(path)
    SQLModel.metadata.create_all(engine)
    return engine


def reset_db(path: Path | None = None) -> Engine:
    """Drop and recreate all tables. Used by `make seed`."""
    import api.models  # noqa: F401

    engine = get_engine(path)
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    return engine


@contextmanager
def session_scope(path: Path | None = None) -> Iterator[Session]:
    with Session(get_engine(path)) as session:
        yield session


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    with Session(get_engine()) as session:
        yield session
