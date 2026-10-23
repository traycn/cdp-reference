"""Database connection and repository paths."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import psycopg

# Same default as services/ingest/src/loader.ts: the docker-compose database.
DEFAULT_DATABASE_URL = "postgres://cdp:cdp_local_only@localhost:5432/cdp"

REPO_ROOT = Path(__file__).resolve().parents[4]
DATA_DIR = REPO_ROOT / ".data"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)


def connect(url: str | None = None) -> psycopg.Connection[tuple[Any, ...]]:
    """Autocommit, so `conn.transaction()` opens a real transaction, not a savepoint."""
    return psycopg.connect(url or database_url(), autocommit=True)


def loaded_seed(conn: psycopg.Connection[tuple[Any, ...]]) -> int:
    """The seed currently in raw.* (the loader's batch_id is `seed<N>-<sha>`)."""
    rows = conn.execute("SELECT DISTINCT batch_id FROM raw.crm_contact").fetchall()
    seeds = {str(r[0]).split("-", 1)[0].removeprefix("seed") for r in rows}
    if len(seeds) != 1:
        raise RuntimeError(f"expected one loaded seed in raw.crm_contact, found {sorted(seeds)}")
    return int(seeds.pop())
