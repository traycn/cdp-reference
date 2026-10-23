"""Event attachment under a device rule, and how often it attaches to the wrong person.

attachment        events attached to a profile ÷ events whose device is attachable
                  (has at least one form submission); docs/acceptance.md.
wrong attachment  attached events whose profile holds none of the event's true
                  person's person records (CRM contacts, form submissions) ÷
                  attached events. The true person is the device's, from
                  eval.truth_record. Read by evaluation only, never by the pipeline.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from typing import Any

import psycopg

from cdp_stitch.devices import RULES, Event, FormFill

Conn = psycopg.Connection[tuple[Any, ...]]


def read_form_fills(conn: Conn) -> list[FormFill]:
    """Each form submission with its device, time and profile (from core.identity_link)."""
    rows = conn.execute(
        """SELECT f.anonymous_id, f.occurred_at, l.profile_id::text
           FROM staging.form_submission f
           JOIN core.identity_link l
             ON l.id_type = 'form_submission' AND l.id_value = f.source_event_id
           ORDER BY f.source_event_id"""
    ).fetchall()
    return [FormFill(device=d, occurred_at=t, profile=p) for d, t, p in rows]


def read_events(conn: Conn, devices: set[str]) -> list[Event]:
    """Web events and ad clicks on the given devices."""
    rows = conn.execute(
        """SELECT source_event_id, anonymous_id, occurred_at FROM raw.web_event
           UNION ALL
           SELECT source_event_id, anonymous_id, occurred_at FROM raw.ad_click
           WHERE anonymous_id IS NOT NULL"""
    ).fetchall()
    return [Event(event_id=e, device=d, occurred_at=t) for e, d, t in rows if d in devices]


class Truth:
    """The true person of each device and the persons whose records each profile holds."""

    def __init__(self, conn: Conn) -> None:
        self.device_person: dict[str, str] = dict(
            conn.execute(
                "SELECT unit_key, person_id FROM eval.truth_record WHERE unit_type = 'device'"
            ).fetchall()
        )
        self.profile_persons: dict[str, set[str]] = defaultdict(set)
        self.profile_crm_persons: dict[str, set[str]] = defaultdict(set)
        self.crm_persons: set[str] = set()
        for pid, person, is_crm in conn.execute(
            """SELECT l.profile_id::text, t.person_id, l.id_type = 'crm_id'
               FROM core.identity_link l
               JOIN eval.truth_record t
                 ON t.unit_key = l.id_value
                AND t.unit_type = CASE l.id_type WHEN 'crm_id' THEN 'crm_contact'
                                                 ELSE 'form_submission' END
               WHERE l.id_type IN ('crm_id', 'form_submission')"""
        ).fetchall():
            self.profile_persons[pid].add(person)
            if is_crm:
                self.profile_crm_persons[pid].add(person)
                self.crm_persons.add(person)


def attachment_metrics(
    assigned: dict[str, str], events: list[Event], truth: Truth
) -> dict[str, Any]:
    attached = wrong = fragment = 0
    for e in events:
        pid = assigned.get(e.event_id)
        if pid is None:
            continue
        attached += 1
        person = truth.device_person[e.device]
        wrong += person not in truth.profile_persons[pid]
        fragment += person in truth.crm_persons and person not in truth.profile_crm_persons[pid]
    return {
        "events": len(events),
        "attached": attached,
        "rate": round(attached / len(events), 6) if events else None,
        "wrong": wrong,
        "wrong_rate": round(wrong / attached, 6) if attached else None,
        "fragment": fragment,
        "fragment_rate": round(fragment / attached, 6) if attached else None,
    }


def linked_devices(conn: Conn) -> dict[str, str]:
    """device → profile as written by the pipeline."""
    return dict(
        conn.execute(
            "SELECT id_value, profile_id::text FROM core.identity_link "
            "WHERE id_type = 'anonymous_id'"
        ).fetchall()
    )


def current_attachment(conn: Conn) -> dict[str, Any]:
    """Attachment and wrong attachment of the device links in core.identity_link."""
    fills = read_form_fills(conn)
    events = read_events(conn, {f.device for f in fills})
    device_profile = linked_devices(conn)
    assigned = {e.event_id: device_profile[e.device] for e in events if e.device in device_profile}
    return attachment_metrics(assigned, events, Truth(conn))


def compare_rules(
    conn: Conn,
    rules: dict[str, Callable[[list[FormFill], list[Event]], dict[str, str]]] = RULES,
) -> dict[str, dict[str, Any]]:
    """Attachment and wrong attachment for every rule, on the loaded seed."""
    fills = read_form_fills(conn)
    events = read_events(conn, {f.device for f in fills})
    truth = Truth(conn)
    return {
        name: attachment_metrics(rule(fills, events), events, truth) for name, rule in rules.items()
    }
