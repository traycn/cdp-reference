"""A throwaway database per test session: created next to DATABASE_URL's database,
migrated from db/migrations, filled with a few hand-written raw rows, then dropped.
The tests never touch the development data. Without a reachable Postgres, the
database tests are skipped."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

from cdp_stitch.db import REPO_ROOT, database_url

MIGRATIONS = REPO_ROOT / "db" / "migrations"

# Jane Doe: a CRM contact (with an opportunity) and two form fills under her email.
# Bob Roe: one form fill, no CRM contact.
# Devices: dev-jane (Jane's fills only), dev-bob (Bob's), dev-shared (one fill each,
# in its own session, so its fills fall in two profiles), dev-none (page views only,
# no form fill).
CRM_CONTACTS = [
    # crm_id, email, verified, phone, first, last, dob, address, city, state, zip, company,
    # title, updated_at (23:30 in New York is the next day in UTC)
    ("C000001", " Jane.Doe@Example.com", True, "(617) 253-1000", "Jane", "Doe", None,
     "1 Main St", "Boston", "ma", "02139", "Acme", "CTO", "2025-03-01T23:30:00-05:00"),
]  # fmt: skip
FORMS = [
    # source_event_id, occurred_at, anonymous_id, email, properties (+ FORM_SESSIONS)
    ("W0000002", "2025-02-01T10:00:00Z", "dev-jane", "jane.doe@example.com",
     '{"first_name": "Jane", "last_name": "Doe", "company": "Acme"}'),
    ("W0000004", "2025-02-02T10:00:00Z", "dev-bob", "bob@roe.example",
     '{"first_name": "Bob", "last_name": "Roe", "company": "Initech", "phone": "212-639-2000"}'),
    ("W0000006", "2025-02-03T10:00:00Z", "dev-shared", "jane.doe@example.com",
     '{"first_name": "Jane", "last_name": "Doe", "company": "Acme"}'),
    ("W0000008", "2025-02-04T10:00:00Z", "dev-shared", "bob@roe.example",
     '{"first_name": "Bob", "last_name": "Roe", "company": "Initech"}'),
]  # fmt: skip
# Each form fill's session_id; every fill is in a session of its own.
FORM_SESSIONS = {
    "W0000002": "s_jane",
    "W0000004": "s_bob",
    "W0000006": "s_shared_jane",
    "W0000008": "s_shared_bob",
}
PAGE_VIEWS = [
    ("W0000001", "2025-02-01T09:58:00Z", "dev-jane"),
    ("W0000003", "2025-02-02T09:58:00Z", "dev-bob"),
    ("W0000005", "2025-02-03T09:58:00Z", "dev-shared"),
    ("W0000009", "2025-02-05T09:58:00Z", "dev-none"),
]
OPPORTUNITIES = [("O000001", "C000001", "closed_won", "1200.00", "2025-03-05T00:00:00Z")]


def _migrate(conn: psycopg.Connection[tuple[Any, ...]]) -> None:
    for path in sorted(MIGRATIONS.glob("*.sql")):
        up = path.read_text(encoding="utf-8").split("-- migrate:down", 1)[0]
        conn.execute(up.encode())


def _seed(conn: psycopg.Connection[tuple[Any, ...]]) -> None:
    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO raw.crm_contact (crm_id, email, email_verified, phone, first_name, "
            "last_name, dob, address, city, state, zip, company, title, updated_at, batch_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'test')",
            CRM_CONTACTS,
        )
        cur.executemany(
            "INSERT INTO raw.web_event (source_event_id, occurred_at, anonymous_id, event_name, "
            "page_path, email, properties, batch_id) "
            "VALUES (%s, %s, %s, 'form_submit', '/demo', %s, "
            "%s::jsonb || jsonb_build_object('session_id', %s::text), 'test')",
            [(*form, FORM_SESSIONS[form[0]]) for form in FORMS],
        )
        cur.executemany(
            "INSERT INTO raw.web_event (source_event_id, occurred_at, anonymous_id, event_name, "
            "page_path, batch_id) VALUES (%s, %s, %s, 'page_view', '/', 'test')",
            PAGE_VIEWS,
        )
        cur.executemany(
            "INSERT INTO raw.crm_opportunity (opp_id, crm_id, stage, amount, opened_at, batch_id) "
            "VALUES (%s, %s, %s, %s, %s, 'test')",
            OPPORTUNITIES,
        )


@pytest.fixture(scope="session")
def test_db_url() -> Iterator[str]:
    admin_url = database_url()
    name = f"cdp_stitch_test_{uuid.uuid4().hex[:8]}"
    try:
        admin = psycopg.connect(admin_url, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as exc:
        if os.environ.get("CI"):
            raise
        pytest.skip(f"no Postgres at DATABASE_URL: {exc}")
    with admin:
        admin.execute(f'CREATE DATABASE "{name}"')
        url = make_conninfo(admin_url, dbname=name)
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                _migrate(conn)
                _seed(conn)
            yield url
        finally:
            admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')


@pytest.fixture
def conn(test_db_url: str) -> Iterator[psycopg.Connection[tuple[Any, ...]]]:
    with psycopg.connect(test_db_url, autocommit=True) as c:
        yield c
