"""Export person records (CRM contacts and form submissions) in 01's CSV format.

Column mapping: docs/adr/0001-reuse-entity-resolution.md, "Which 01 rules fire on
02's fields". Both kinds go into one CSV, so 01's `load_sources` concatenates a
single frame; form rows leave the CRM-only columns empty.
"""

from __future__ import annotations

import csv
import hashlib
from pathlib import Path
from typing import Any

import psycopg

COLUMNS = (
    "record_id",
    "source",
    "first_name",
    "last_name",
    "email",
    "email_verified",
    "phone",
    "address",
    "city",
    "state",
    "zip",
    "dob",
    "updated_at",
)

# 01's normalize_date reads dates, not timestamps, so `updated_at` is sent as the
# UTC day. A full timestamp would parse as missing and drop recency from
# survivorship; same-day ties fall back to 01's record_id order.
_QUERY = """
SELECT * FROM (
SELECT 'crm:' || crm_id AS record_id, 'crm', first_name, last_name, email,
       CASE WHEN email_verified THEN 'true' WHEN NOT email_verified THEN 'false' END,
       phone, address, city, state, zip, to_char(dob, 'YYYY-MM-DD'),
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
FROM staging.crm_contact
UNION ALL
SELECT 'form:' || source_event_id, 'web_form', first_name, last_name, email,
       NULL, phone, NULL, NULL, NULL, NULL, NULL,
       to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
FROM staging.form_submission
) r
ORDER BY record_id COLLATE "C"
"""


def export_person_records(conn: psycopg.Connection[tuple[Any, ...]], path: Path) -> int:
    """Write the records to `path`; returns the row count."""
    rows = conn.execute(_QUERY).fetchall()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(COLUMNS)
        writer.writerows(["" if v is None else str(v) for v in row] for row in rows)
    return len(rows)


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
