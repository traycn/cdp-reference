"""Idempotent stitch check (docs/acceptance.md, Data and pipeline): re-stitching
changes neither row counts nor the profile hash."""

from __future__ import annotations

import hashlib
from typing import Any

import psycopg

CORE_TABLES = ("core.customer_profile", "core.identity_link", "core.link_evidence")


def row_counts(conn: psycopg.Connection[tuple[Any, ...]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in CORE_TABLES:
        row = conn.execute(f"SELECT count(*) FROM {table}").fetchone()
        assert row is not None
        counts[table] = int(row[0])
    return counts


def profile_hash(conn: psycopg.Connection[tuple[Any, ...]]) -> str:
    """SHA-256 of the sorted list of each profile_id with its sorted (id_type, id_value) pairs.

    One line per profile: `<profile_id>\\t<id_type>=<id_value>\\t...`, byte order.
    """
    rows = conn.execute(
        """SELECT p.profile_id::text,
                  coalesce(string_agg(l.id_type || '=' || l.id_value, E'\\t'
                           ORDER BY l.id_type COLLATE "C", l.id_value COLLATE "C"), '')
           FROM core.customer_profile p
           LEFT JOIN core.identity_link l USING (profile_id)
           GROUP BY p.profile_id
           ORDER BY p.profile_id::text COLLATE "C" """
    ).fetchall()
    digest = hashlib.sha256()
    for pid, links in rows:
        digest.update(f"{pid}\t{links}\n".encode())
    return digest.hexdigest()
