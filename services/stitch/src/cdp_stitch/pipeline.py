"""One stitching run: export → 01's resolver (unchanged) → load into core.

Person-to-person merges come only from 01. SQL adds the fixed links afterwards:
  - opportunity → the profile of its crm_id (structural);
  - devices and sessions by rule (d), ADR 0004 (cdp_stitch.devices):
    a session containing a form fill → that fill's profile ('session_id');
    a device → the profile holding most of its form fills ('anonymous_id').
    An event's profile is its session's link if it has one, else its
    device's. A device with a tie for most fills gets no device link and is
    counted as a device conflict. A device never merges profiles.

Every link has confidence 1.0: each comes from a deterministic rule (01's
exact_id under allow_weighted_match = false, a foreign key, a session's own
form fill, or a device majority). 01's weighted similarity is not a probability, so it stays in
core.link_evidence.score instead (ADR 0001, "Confirm at M3").

core is rebuilt in one transaction. Profile IDs are UUIDv5 of the anchor key,
so profiles that survive a re-run keep their ID and their rows in later tables.
"""

from __future__ import annotations

import contextlib
import csv
import io
import json
import time
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import psycopg
from resolver.cli import run as resolver_run

from cdp_stitch import devices
from cdp_stitch.device_eval import read_form_fills
from cdp_stitch.engine import EngineInfo, engine_info, profile_id
from cdp_stitch.export import export_person_records, file_sha256

UNIT_ID_TYPE = {"crm": "crm_id", "form": "form_submission"}


@dataclass
class StitchResult:
    run_id: str
    engine: str
    engine_version: str
    engine_commit: str
    person_records: int
    profiles: int
    links: dict[str, int]
    evidence: dict[str, int]
    device_conflicts: int
    seconds: dict[str, float] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True) + "\n"


@dataclass(frozen=True)
class Evidence:
    left: str
    right: str
    decision: str
    rule: str
    score: float
    field_scores: dict[str, float]


@contextlib.contextmanager
def _timed(seconds: dict[str, float], name: str) -> Iterator[None]:
    t0 = time.perf_counter()
    yield
    seconds[name] = round(time.perf_counter() - t0, 2)


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _evidence(row: dict[str, Any], decision: str) -> Evidence:
    return Evidence(
        left=row["left_id"],
        right=row["right_id"],
        decision=decision,
        rule=row["rule"],
        score=float(row["score"]),
        field_scores=dict(row["field_scores"]),
    )


def read_evidence(out: Path) -> list[Evidence]:
    """Every pair decision 01 writes out:
    - MATCH: edges kept inside a cluster (audit.jsonl);
    - SPLIT: MATCH edges the conflict-aware clustering rejected (splits.jsonl,
      `rejected_edges`), keeping 01's rule, e.g. exact_id;
    - REVIEW: review.jsonl.
    01's CLI does not write NO_MATCH pairs, so link_evidence has none.
    """
    found: dict[tuple[str, str], Evidence] = {}

    def add(ev: Evidence) -> None:
        key = (ev.left, ev.right)
        if key in found and found[key] != ev:
            raise RuntimeError(f"pair {key} has two decisions: {found[key]} and {ev}")
        found[key] = ev

    for entry in _read_jsonl(out / "audit.jsonl"):
        for edge in entry["edges"]:
            add(_evidence(edge, "MATCH"))
    for split in _read_jsonl(out / "splits.jsonl"):
        explained = {(e["left_id"], e["right_id"]): e for e in split["edges"]}
        for left, right in split["rejected_edges"]:
            add(_evidence(explained[(left, right)], "SPLIT"))
    for row in _read_jsonl(out / "review.jsonl"):
        add(_evidence(row, "REVIEW"))
    return [found[k] for k in sorted(found)]


def read_clusters(out: Path) -> dict[str, list[str]]:
    """anchor key (smallest member in byte order) → sorted members."""
    members: dict[str, list[str]] = {}
    with (out / "clusters.csv").open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            members.setdefault(row["cluster_id"], []).append(row["record_id"])
    clusters: dict[str, list[str]] = {}
    for group in members.values():
        group.sort()
        clusters[group[0]] = group
    return clusters


def read_golden(out: Path) -> dict[str, dict[str, str]]:
    """01's golden record per cluster, keyed by its smallest member."""
    with (out / "golden.csv").open(newline="", encoding="utf-8") as fh:
        return {row["golden_id"].removeprefix("G-"): row for row in csv.DictReader(fh)}


def _copy(
    cur: psycopg.Cursor[Any], table: str, columns: list[str], rows: list[tuple[Any, ...]]
) -> None:
    with cur.copy(f"COPY {table} ({', '.join(columns)}) FROM STDIN") as copy:
        for row in rows:
            copy.write_row(row)


def run_stitch(
    conn: psycopg.Connection[tuple[Any, ...]],
    work_dir: Path,
) -> StitchResult:
    seconds: dict[str, float] = {}
    engine = engine_info()
    sources, out = work_dir / "sources", work_dir / "out"
    for d in (sources, out):
        d.mkdir(parents=True, exist_ok=True)
        for old in d.iterdir():
            old.unlink()

    with _timed(seconds, "export"):
        export_file = sources / "person_records.csv"
        n_records = export_person_records(conn, export_file)
        run_id = f"{engine.version}-{file_sha256(export_file)[:12]}"

    with _timed(seconds, "resolve"), contextlib.redirect_stdout(io.StringIO()):
        resolver_run(sources=sources, out=out, decisions=None)

    with _timed(seconds, "load"):
        clusters = read_clusters(out)
        golden = read_golden(out)
        evidence = read_evidence(out)
        result = _load(conn, engine, run_id, clusters, golden, evidence)

    result.person_records = n_records
    result.seconds = seconds
    return result


def _load(
    conn: psycopg.Connection[tuple[Any, ...]],
    engine: EngineInfo,
    run_id: str,
    clusters: dict[str, list[str]],
    golden: dict[str, dict[str, str]],
    evidence: list[Evidence],
) -> StitchResult:
    company = dict(
        conn.execute(
            "SELECT 'crm:' || crm_id, company FROM staging.crm_contact UNION ALL "
            "SELECT 'form:' || source_event_id, company FROM staging.form_submission"
        ).fetchall()
    )

    profiles: list[tuple[Any, ...]] = []
    unit_links: list[tuple[Any, ...]] = []
    for anchor, members in sorted(clusters.items()):
        g = golden[anchor]
        pid = profile_id(anchor)
        name = " ".join(p for p in (g["first_name"], g["last_name"]) if p) or None
        # company is not a 01 field: it comes with the record that supplied the name.
        profiles.append(
            (
                pid,
                anchor,
                g["email"] or None,
                g["phone"] or None,
                name,
                company.get(g["first_name__source"]) if g["first_name__source"] else None,
            )
        )
        for member in members:
            kind, key = member.split(":", 1)
            unit_links.append((pid, UNIT_ID_TYPE[kind], key, "resolver", 1.0))

    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            "CREATE TEMP TABLE new_profile ON COMMIT DROP AS SELECT profile_id, anchor_key, "
            "primary_email, primary_phone, full_name, company "
            "FROM core.customer_profile WITH NO DATA"
        )
        cols = [
            "profile_id",
            "anchor_key",
            "primary_email",
            "primary_phone",
            "full_name",
            "company",
        ]
        _copy(cur, "new_profile", cols, profiles)
        changed = (
            ", ".join(f"p.{c}" for c in cols[2:]),
            ", ".join(f"EXCLUDED.{c}" for c in cols[2:]),
        )
        cur.execute(
            f"""INSERT INTO core.customer_profile AS p ({", ".join(cols)})
                SELECT {", ".join(cols)} FROM new_profile
                ON CONFLICT (profile_id) DO UPDATE SET
                  {", ".join(f"{c} = EXCLUDED.{c}" for c in cols[2:])}, updated_at = now()
                WHERE ({changed[0]}) IS DISTINCT FROM ({changed[1]})"""
        )
        cur.execute(
            "DELETE FROM core.customer_profile p WHERE NOT EXISTS "
            "(SELECT 1 FROM new_profile n WHERE n.profile_id = p.profile_id)"
        )
        cur.execute("DELETE FROM core.identity_link")
        cur.execute("DELETE FROM core.link_evidence")

        link_cols = ["profile_id", "id_type", "id_value", "source", "confidence"]
        _copy(cur, "core.identity_link", link_cols, unit_links)
        _copy(
            cur,
            "core.link_evidence",
            ["run_id", "left_key", "right_key", "decision", "rule", "score", "field_scores",
             "engine", "engine_version"],
            [
                (run_id, e.left, e.right, e.decision, e.rule, e.score,
                 json.dumps(e.field_scores, sort_keys=True), engine.name, engine.version)
                for e in evidence
            ],
        )  # fmt: skip

        # Structural: an opportunity belongs to the profile of its CRM contact.
        cur.execute(
            """INSERT INTO core.identity_link (profile_id, id_type, id_value, source, confidence)
               SELECT l.profile_id, 'opp_id', o.opp_id, 'structural', 1.0
               FROM staging.crm_opportunity o
               JOIN core.identity_link l ON l.id_type = 'crm_id' AND l.id_value = o.crm_id"""
        )
        # Devices and sessions: rule (d), session + majority (ADR 0004).
        fills = read_form_fills(conn)
        device_links = [
            (pid, "anonymous_id", device, "device", 1.0)
            for device, pid in sorted(devices.majority(fills).items())
        ]
        session_links = [
            (pid, "session_id", session, "session", 1.0)
            for session, pid in sorted(devices.session_profiles(fills).items())
        ]
        _copy(cur, "core.identity_link", link_cols, device_links + session_links)
        device_conflicts = len(devices.unattached_devices(fills))
        # Contact points of each profile's person records, for search and display.
        # One email or phone can sit on several profiles (a shared household phone).
        cur.execute(
            """INSERT INTO core.identity_link (profile_id, id_type, id_value, source, confidence)
               SELECT DISTINCT l.profile_id, v.id_type, v.id_value, 'resolver', 1.0
               FROM core.identity_link l
               JOIN (SELECT 'crm_id' AS unit, crm_id AS key, email, phone FROM staging.crm_contact
                     UNION ALL
                     SELECT 'form_submission', source_event_id, email, phone
                     FROM staging.form_submission) r
                 ON r.unit = l.id_type AND r.key = l.id_value
               CROSS JOIN LATERAL (VALUES ('email', r.email), ('phone', r.phone))
                 AS v (id_type, id_value)
               WHERE v.id_value IS NOT NULL"""
        )
        cur.execute("SELECT id_type, count(*) FROM core.identity_link GROUP BY 1 ORDER BY 1")
        links = {str(t): int(n) for t, n in cur.fetchall()}
        cur.execute("SELECT decision, count(*) FROM core.link_evidence GROUP BY 1 ORDER BY 1")
        by_decision = {str(d): int(n) for d, n in cur.fetchall()}

    return StitchResult(
        run_id=run_id,
        engine=engine.name,
        engine_version=engine.version,
        engine_commit=engine.commit,
        person_records=0,
        profiles=len(profiles),
        links=links,
        evidence=by_decision,
        device_conflicts=device_conflicts,
    )
