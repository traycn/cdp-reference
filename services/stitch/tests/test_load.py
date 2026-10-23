"""A full stitch on the fixture database: profiles, links, and load idempotency."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from cdp_stitch.engine import profile_id
from cdp_stitch.idempotency import profile_hash, row_counts
from cdp_stitch.pipeline import run_stitch


def _links(conn: Any) -> dict[tuple[str, str], str]:
    rows = conn.execute(
        "SELECT id_type, id_value, profile_id FROM core.identity_link "
        "WHERE id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'opp_id', 'session_id')"
    ).fetchall()
    return {(t, v): str(p) for t, v, p in rows}


def test_stitch_builds_profiles_and_links(conn: Any, tmp_path: Path) -> None:
    result = run_stitch(conn, tmp_path)
    links = _links(conn)
    jane, bob = str(profile_id("crm:C000001")), str(profile_id("form:W0000004"))

    assert result.profiles == 2
    assert {links[("crm_id", "C000001")], links[("form_submission", "W0000002")],
            links[("form_submission", "W0000006")]} == {jane}  # fmt: skip
    assert links[("form_submission", "W0000008")] == bob
    assert links[("opp_id", "O000001")] == jane  # structural
    # Rule (d), ADR 0004. Devices go to the profile with most of their fills;
    # dev-shared is a 1-1 tie, so it gets no device link, and dev-none has no fills.
    assert links[("anonymous_id", "dev-jane")] == jane
    assert links[("anonymous_id", "dev-bob")] == bob
    assert ("anonymous_id", "dev-shared") not in links
    assert ("anonymous_id", "dev-none") not in links
    assert result.device_conflicts == 1
    # Each session with a fill goes to that fill's profile, also on dev-shared.
    assert links[("session_id", "s_shared_jane")] == jane
    assert links[("session_id", "s_shared_bob")] == bob
    assert links[("session_id", "s_jane")] == jane
    # Jane's contact and two forms share an email (3 pairs), so do Bob's two forms
    # (1 pair): all joined by 01's exact_id.
    assert result.evidence == {"MATCH": 4}


def test_restitching_changes_no_row_count_or_profile_hash(conn: Any, tmp_path: Path) -> None:
    run_stitch(conn, tmp_path)
    first = (row_counts(conn), profile_hash(conn))
    created = conn.execute("SELECT max(created_at) FROM core.customer_profile").fetchone()
    run_stitch(conn, tmp_path)
    assert (row_counts(conn), profile_hash(conn)) == first
    # Unchanged profiles are kept, not recreated, so later tables' rows survive.
    assert conn.execute("SELECT max(created_at) FROM core.customer_profile").fetchone() == created


def test_profile_ids_are_uuidv5_of_the_smallest_member(conn: Any, tmp_path: Path) -> None:
    run_stitch(conn, tmp_path)
    rows = conn.execute("SELECT anchor_key, profile_id FROM core.customer_profile").fetchall()
    assert {a: str(p) for a, p in rows} == {
        "crm:C000001": str(profile_id("crm:C000001")),
        "form:W0000004": str(profile_id("form:W0000004")),
    }
