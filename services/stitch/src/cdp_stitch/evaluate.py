"""M3 identity metrics (docs/acceptance.md, "Identity metrics") against eval.truth_*.

Reads only the database: core.identity_link for each unit's profile, eval.* for the
truth. Units are CRM contacts (crm_id), form submissions (source_event_id) and
devices (anonymous_id). A device is attachable when it has at least one form
submission; devices without one are left out of completeness, recall and event
attachment, since nothing can link them. Wrong attachment (events attached to a
profile that holds none of their true person's records) is reported for every
seed; it has no bar (cdp_stitch.device_eval).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from itertools import combinations
from math import comb
from typing import Any

import psycopg
from resolver.normalize import normalize_email, normalize_phone
from resolver.scoring import NormalizedRecord, has_conflicting_identifiers

from cdp_stitch.device_eval import current_attachment
from cdp_stitch.engine import engine_info

# docs/acceptance.md bars, per seed. The mean-precision bar is checked across
# seeds in report.py.
BAR_PRECISION = 0.98
BAR_PRECISION_MEAN = 0.99
BAR_COMPLETENESS = 0.80
BAR_SAFETY = 0
BAR_ATTACHMENT = 0.95

COMPLETENESS_KINDS = ("ordinary", "multi_email", "multi_device")
HAZARD_KINDS = ("same_name_relative", "shared_household_phone")
DOB_GROUPS = ("both", "one", "none")
EXAMPLES = 10

LINK_UNIT = {
    "crm_id": "crm_contact",
    "form_submission": "form_submission",
    "anonymous_id": "device",
}
RECORD_PREFIX = {"crm_contact": "crm:", "form_submission": "form:"}

Unit = tuple[str, str]  # (unit_type, unit_key)
Conn = psycopg.Connection[tuple[Any, ...]]


def _rows(conn: Conn, sql: str) -> list[tuple[Any, ...]]:
    return conn.execute(sql).fetchall()


def _ratio(num: int, den: int) -> float | None:
    return round(num / den, 6) if den else None


def evaluate(conn: Conn, seed: int) -> dict[str, Any]:
    engine = engine_info()
    truth: dict[Unit, tuple[str, str]] = {
        (t, k): (p, kind)
        for t, k, p, kind in _rows(
            conn, "SELECT unit_type, unit_key, person_id, person_kind FROM eval.truth_record"
        )
    }
    kind_of = {p: kind for p, kind in truth.values()}
    profile: dict[Unit, str] = {
        (LINK_UNIT[t], v): str(pid)
        for pid, t, v in _rows(
            conn,
            "SELECT profile_id, id_type, id_value FROM core.identity_link "
            "WHERE id_type IN ('crm_id', 'form_submission', 'anonymous_id')",
        )
    }
    form_devices = {
        str(r[0]) for r in _rows(conn, "SELECT DISTINCT anonymous_id FROM staging.form_submission")
    }

    def attachable(u: Unit) -> bool:
        return u[0] != "device" or u[1] in form_devices

    units_of: dict[str, list[Unit]] = defaultdict(list)
    for u, (person, _) in truth.items():
        if attachable(u):
            units_of[person].append(u)
    missing = [u for u in profile if u not in truth]
    if missing:
        raise RuntimeError(f"{len(missing)} linked units have no truth row, e.g. {missing[:3]}")
    unlinked_records = [u for u in truth if u[0] != "device" and u not in profile]
    if unlinked_records:
        raise RuntimeError(f"{len(unlinked_records)} person records have no profile")

    # -- pairwise precision and recall -------------------------------------
    members: dict[str, list[Unit]] = defaultdict(list)
    for u, pid in profile.items():
        members[pid].append(u)
    pairs_in_profiles = 0
    same_person_pairs = 0
    impure: list[dict[str, Any]] = []
    for pid, us in members.items():
        by_person = Counter(truth[u][0] for u in us)
        pairs_in_profiles += comb(len(us), 2)
        same_person_pairs += sum(comb(n, 2) for n in by_person.values())
        if len(by_person) > 1:
            impure.append({"profile_id": pid, "persons": dict(sorted(by_person.items()))})
    true_pairs = sum(comb(len(us), 2) for us in units_of.values())

    # -- person completeness ---------------------------------------------
    completeness: dict[str, dict[str, Any]] = {}
    incomplete_examples: list[dict[str, Any]] = []
    incomplete_reasons: Counter[str] = Counter()
    for kind in (*COMPLETENESS_KINDS, "email_changed"):
        eligible = complete = 0
        for person, us in units_of.items():
            if kind_of[person] != kind or len(us) < 2:
                continue
            eligible += 1
            pids = {profile.get(u) for u in us}
            if len(pids) == 1 and None not in pids:
                complete += 1
            elif kind != "email_changed":
                reason = _incomplete_reason(us, profile)
                incomplete_reasons[f"{kind}: {reason}"] += 1
                if len(incomplete_examples) < EXAMPLES:
                    incomplete_examples.append(
                        {
                            "person_id": person,
                            "kind": kind,
                            "reason": reason,
                            "units": {f"{t}:{k}": profile.get((t, k)) for t, k in sorted(us)},
                        }
                    )
        completeness[kind] = {
            "eligible": eligible,
            "complete": complete,
            "rate": _ratio(complete, eligible),
        }
    combined_eligible = sum(completeness[k]["eligible"] for k in COMPLETENESS_KINDS)
    combined_complete = sum(completeness[k]["complete"] for k in COMPLETENESS_KINDS)

    # -- email_changed: which 01 rule joined or split the two contacts ----
    evidence = {
        (str(a), str(b)): (str(d), str(r))
        for a, b, d, r in _rows(
            conn, "SELECT left_key, right_key, decision, rule FROM core.link_evidence"
        )
    }
    email_changed: Counter[tuple[str, str, str]] = Counter()
    for person, us in units_of.items():
        if kind_of[person] != "email_changed":
            continue
        contacts = sorted(k for t, k in us if t == "crm_contact")
        a, b = (f"crm:{k}" for k in contacts)
        decision, rule = evidence.get((a, b), ("none", "no pair decision (NO_MATCH or unblocked)"))
        joined = profile[("crm_contact", contacts[0])] == profile[("crm_contact", contacts[1])]
        email_changed["joined" if joined else "split", decision, rule] += 1

    # -- safety (01's conflict rule, with 01's normalizers) ---------------
    contact_ids: dict[str, NormalizedRecord] = {
        str(crm_id): {"email": normalize_email(email), "phone": normalize_phone(phone)}
        for crm_id, email, phone in _rows(conn, "SELECT crm_id, email, phone FROM raw.crm_contact")
    }
    unsafe: list[dict[str, Any]] = []
    for pid, us in members.items():
        contacts = sorted(k for t, k in us if t == "crm_contact")
        bad = [
            (a, b)
            for a, b in combinations(contacts, 2)
            if has_conflicting_identifiers(contact_ids[a], contact_ids[b])
        ]
        if bad:
            unsafe.append({"profile_id": pid, "conflicting_contacts": bad})

    # -- event attachment and wrong attachment (device links as written) ----
    attached_devices = {k for t, k in profile if t == "device"}
    event_attachment = current_attachment(conn)
    device_conflicts = sum(1 for d in form_devices if d not in attached_devices)

    # -- 01 decisions by rule ------------------------------------------------
    decisions: dict[str, dict[str, int]] = defaultdict(dict)
    for decision, rule, n in _rows(
        conn,
        "SELECT decision, rule, count(*) FROM core.link_evidence GROUP BY 1, 2 ORDER BY 1, 2",
    ):
        decisions[str(decision)][str(rule)] = int(n)

    # -- hard-case report ------------------------------------------------------
    person_profiles: dict[str, set[str]] = defaultdict(set)
    for u, pid in profile.items():
        person_profiles[truth[u][0]].add(pid)
    dob = {str(c): d is not None for c, d in _rows(conn, "SELECT crm_id, dob FROM raw.crm_contact")}
    person_contact = {p: k for (t, k), (p, _) in truth.items() if t == "crm_contact"}
    hard: dict[str, dict[str, dict[str, int]]] = {
        k: {g: {"pairs": 0, "merged": 0} for g in DOB_GROUPS} for k in HAZARD_KINDS
    }
    hazard_merges: list[dict[str, Any]] = []
    hazard_outcomes: Counter[tuple[str, str, str, str]] = Counter()
    for a, b, kind in _rows(conn, "SELECT person_a, person_b, kind FROM eval.truth_hazard_pair"):
        ca, cb = person_contact[a], person_contact[b]
        group = DOB_GROUPS[2 - (dob[ca] + dob[cb])]
        merged = bool(person_profiles[a] & person_profiles[b])
        cell = hard[kind][group]
        cell["pairs"] += 1
        cell["merged"] += merged
        left, right = sorted((f"crm:{ca}", f"crm:{cb}"))
        decision, rule = evidence.get((left, right), ("none", "no pair decision"))
        hazard_outcomes[kind, group, decision, rule] += 1
        if merged:
            hazard_merges.append(
                {
                    "kind": kind,
                    "dob": group,
                    "person_a": a,
                    "person_b": b,
                    "contacts": [left, right],
                    "decision": decision,
                    "rule": rule,
                }
            )

    return {
        "seed": seed,
        "engine": {"name": engine.name, "version": engine.version, "commit": engine.commit},
        "counts": {
            "person_records": sum(1 for u in truth if u[0] != "device"),
            "profiles": len(members),
            "multi_record_profiles": sum(
                1 for us in members.values() if sum(u[0] != "device" for u in us) > 1
            ),
            "attachable_devices": len(form_devices),
            "attached_devices": len(attached_devices),
            "people_with_2plus_attachable_units": sum(
                1 for us in units_of.values() if len(us) >= 2
            ),
        },
        "precision": {
            "same_person_pairs": same_person_pairs,
            "pairs": pairs_in_profiles,
            "rate": _ratio(same_person_pairs, pairs_in_profiles),
        },
        "recall": {
            "same_profile_pairs": same_person_pairs,
            "pairs": true_pairs,
            "rate": _ratio(same_person_pairs, true_pairs),
        },
        "completeness": {
            "combined": {
                "eligible": combined_eligible,
                "complete": combined_complete,
                "rate": _ratio(combined_complete, combined_eligible),
            },
            "by_kind": completeness,
            "incomplete_reasons": dict(sorted(incomplete_reasons.items())),
            "incomplete_examples": incomplete_examples,
        },
        "email_changed_rules": [
            {"outcome": o, "decision": d, "rule": r, "people": n}
            for (o, d, r), n in sorted(email_changed.items())
        ],
        "safety": {"unsafe_profiles": len(unsafe), "examples": unsafe[:EXAMPLES]},
        "event_attachment": event_attachment,
        "device_conflicts": device_conflicts,
        "decisions": dict(sorted(decisions.items())),
        "hard_cases": hard,
        "hard_case_decisions": [
            {"kind": k, "dob": g, "decision": d, "rule": r, "pairs": n}
            for (k, g, d, r), n in sorted(hazard_outcomes.items())
        ],
        "hard_case_merges": hazard_merges,
        "impure_profiles": {"count": len(impure), "examples": impure[:EXAMPLES]},
    }


def _incomplete_reason(units: list[Unit], profile: dict[Unit, str]) -> str:
    """Why a person's attachable units are not all in one profile."""
    records = {profile[u] for u in units if u[0] != "device"}
    devices_unattached = any(u[0] == "device" and u not in profile for u in units)
    if len(records) > 1:
        kinds = sorted({u[0] for u in units if u[0] != "device"})
        return "person records split across profiles (" + " + ".join(kinds) + ")"
    if devices_unattached:
        return "device unattached (conflicting form submissions)"
    return "device attached to another profile"


def failures(m: dict[str, Any]) -> list[str]:
    """Per-seed bars from docs/acceptance.md that this run misses."""
    seed = m["seed"]
    out: list[str] = []
    p = m["precision"]["rate"]
    if p is None or p < BAR_PRECISION:
        out.append(f"seed {seed}: pairwise precision {p} < {BAR_PRECISION}")
    c = m["completeness"]["combined"]["rate"]
    if c is None or c < BAR_COMPLETENESS:
        out.append(f"seed {seed}: person completeness {c} < {BAR_COMPLETENESS}")
    s = m["safety"]["unsafe_profiles"]
    if s > BAR_SAFETY:
        out.append(f"seed {seed}: {s} unsafe profile(s), bar is {BAR_SAFETY}")
    a = m["event_attachment"]["rate"]
    if a is None or a < BAR_ATTACHMENT:
        out.append(f"seed {seed}: event attachment {a} < {BAR_ATTACHMENT}")
    return out


def format_metrics(m: dict[str, Any]) -> str:
    comp = m["completeness"]
    lines = [
        f"seed {m['seed']} · {m['engine']['name']} {m['engine']['version']}",
        f"precision     {m['precision']['rate']}  "
        f"({m['precision']['same_person_pairs']:,}/{m['precision']['pairs']:,})",
        f"completeness  {comp['combined']['rate']}  "
        + "  ".join(f"{k}={v['rate']}" for k, v in comp["by_kind"].items()),
        f"recall        {m['recall']['rate']}",
        f"safety        {m['safety']['unsafe_profiles']} unsafe profiles",
        f"attachment    {m['event_attachment']['rate']}  "
        f"({m['event_attachment']['attached']:,}/{m['event_attachment']['events']:,})",
        f"wrong attach  {m['event_attachment']['wrong_rate']}  "
        f"({m['event_attachment']['wrong']:,}/{m['event_attachment']['attached']:,}, report only)",
        f"device conflicts {m['device_conflicts']:,}",
        "REVIEW        "
        + ", ".join(f"{r}={n}" for r, n in m["decisions"].get("REVIEW", {}).items()),
    ]
    for reason, n in comp["incomplete_reasons"].items():
        lines.append(f"  incomplete  {n:5}  {reason}")
    return "\n".join(lines)
