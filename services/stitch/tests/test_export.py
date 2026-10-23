"""Shape of the person-record export that 01 reads (ADR 0001, column mapping)."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

import psycopg

from cdp_stitch.export import COLUMNS, export_person_records


def _export(conn: psycopg.Connection[tuple[Any, ...]], tmp_path: Path) -> list[dict[str, str]]:
    path = tmp_path / "person_records.csv"
    n = export_person_records(conn, path)
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        assert tuple(reader.fieldnames or ()) == COLUMNS
        rows = list(reader)
    assert len(rows) == n
    return rows


def test_one_row_per_contact_and_form_in_byte_order(conn: Any, tmp_path: Path) -> None:
    ids = [r["record_id"] for r in _export(conn, tmp_path)]
    assert ids == [
        "crm:C000001",
        "form:W0000002",
        "form:W0000004",
        "form:W0000006",
        "form:W0000008",
    ]


def test_crm_row_is_normalized_and_updated_at_is_the_utc_day(conn: Any, tmp_path: Path) -> None:
    crm = _export(conn, tmp_path)[0]
    assert crm == {
        "record_id": "crm:C000001",
        "source": "crm",
        "first_name": "Jane",
        "last_name": "Doe",
        "email": "jane.doe@example.com",
        "email_verified": "true",
        "phone": "+16172531000",
        "address": "1 Main St",
        "city": "Boston",
        "state": "MA",
        "zip": "02139",
        "dob": "",
        # 2025-03-01 23:30 in New York: 01 reads dates only, so the UTC day is sent.
        "updated_at": "2025-03-02",
    }


def test_form_rows_leave_crm_only_columns_empty(conn: Any, tmp_path: Path) -> None:
    forms = {r["record_id"]: r for r in _export(conn, tmp_path)[1:]}
    bob = forms["form:W0000004"]
    assert bob["source"] == "web_form"
    assert (bob["first_name"], bob["last_name"]) == ("Bob", "Roe")
    assert bob["phone"] == "+12126392000"
    assert bob["updated_at"] == "2025-02-02"
    for column in ("email_verified", "address", "city", "state", "zip", "dob"):
        assert bob[column] == "", column
    assert forms["form:W0000002"]["phone"] == ""  # phone is optional on forms
