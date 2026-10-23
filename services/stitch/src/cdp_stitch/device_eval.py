"""Event attachment under a device rule, and how often it attaches to the wrong person.

attachment        events attached to a profile ÷ events whose device is attachable
                  (has at least one form submission); docs/acceptance.md.
wrong attachment  attached events whose profile holds none of the event's true
                  person's person records (CRM contacts, form submissions) ÷
                  attached events. The true person is the one who produced the
                  event (eval.truth_event), which on a shared device may not be
                  the device's owner. Read by evaluation only, never by the pipeline.
fragment          attached events of a person with a CRM contact, on a profile
                  without that contact (report only).
floor             events produced by someone other than the device's owner, in a
                  session with no form fill, ÷ events whose device is attachable.
                  Nothing in such a session says who produced it, so a rule that
                  attaches it can only guess.

Sessions: a web event's session is properties.session_id. An ad click has none;
it joins the session of the next web event on its device within 30 minutes
(ADR 0002's inactivity gap), or is a session of its own.
"""

from __future__ import annotations

from bisect import bisect_left
from collections import defaultdict
from collections.abc import Callable
from dataclasses import replace
from datetime import timedelta
from typing import Any

import psycopg

from cdp_stitch.devices import RULES, Event, FormFill

Conn = psycopg.Connection[tuple[Any, ...]]


def read_form_fills(conn: Conn) -> list[FormFill]:
    """Each form submission with its device, time, session and profile (core.identity_link)."""
    rows = conn.execute(
        """SELECT f.anonymous_id, f.occurred_at, l.profile_id::text, w.properties->>'session_id'
           FROM staging.form_submission f
           JOIN raw.web_event w USING (source_event_id)
           JOIN core.identity_link l
             ON l.id_type = 'form_submission' AND l.id_value = f.source_event_id
           ORDER BY f.source_event_id"""
    ).fetchall()
    return [FormFill(device=d, occurred_at=t, profile=p, session=s) for d, t, p, s in rows]


def read_events(conn: Conn, devices: set[str]) -> list[Event]:
    """Web events and ad clicks on the given devices, each with its session."""
    rows = conn.execute(
        """SELECT source_event_id, anonymous_id, occurred_at, properties->>'session_id'
           FROM raw.web_event
           UNION ALL
           SELECT source_event_id, anonymous_id, occurred_at, NULL FROM raw.ad_click
           WHERE anonymous_id IS NOT NULL"""
    ).fetchall()
    events = [
        Event(event_id=e, device=d, occurred_at=t, session=s) for e, d, t, s in rows if d in devices
    ]
    return assign_click_sessions(events)


CLICK_SESSION_GAP = timedelta(minutes=30)


def assign_click_sessions(events: list[Event]) -> list[Event]:
    """Give each event without a session the session of the next sessioned event on its
    device within CLICK_SESSION_GAP, or a session of its own."""
    sessioned: dict[str, list[Event]] = defaultdict(list)
    for e in events:
        if e.session is not None:
            sessioned[e.device].append(e)
    for es in sessioned.values():
        es.sort(key=lambda e: (e.occurred_at, e.event_id))
    times = {d: [e.occurred_at for e in es] for d, es in sessioned.items()}

    out: list[Event] = []
    for e in events:
        session = e.session
        if session is None:
            es = sessioned.get(e.device, [])
            i = bisect_left(times.get(e.device, []), e.occurred_at)
            if i < len(es) and es[i].occurred_at - e.occurred_at <= CLICK_SESSION_GAP:
                session = es[i].session
            else:
                session = f"event:{e.event_id}"
        out.append(replace(e, session=session))
    return out


class Truth:
    """The true person of each event and the persons whose records each profile holds."""

    def __init__(self, conn: Conn) -> None:
        self.device_owner: dict[str, str] = dict(
            conn.execute(
                "SELECT unit_key, person_id FROM eval.truth_record WHERE unit_type = 'device'"
            ).fetchall()
        )
        # source_event_ids are unique across tables (W… for web events, A… for ad clicks).
        self.event_person: dict[str, str] = dict(
            conn.execute("SELECT source_event_id, person_id FROM eval.truth_event").fetchall()
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
        person = truth.event_person[e.event_id]
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


def floor(fills: list[FormFill], events: list[Event], truth: Truth) -> dict[str, Any]:
    """Borrowed events in sessions with no form fill ÷ events on attachable devices."""
    fill_sessions = {f.session for f in fills}
    n = sum(
        1
        for e in events
        if truth.event_person[e.event_id] != truth.device_owner[e.device]
        and e.session not in fill_sessions
    )
    return {"events": len(events), "unidentifiable": n, "rate": round(n / len(events), 6)}


def _links(conn: Conn, id_type: str) -> dict[str, str]:
    return dict(
        conn.execute(
            "SELECT id_value, profile_id::text FROM core.identity_link WHERE id_type = %s",
            (id_type,),
        ).fetchall()
    )


def linked_events(conn: Conn, events: list[Event]) -> dict[str, str]:
    """event_id → profile as written by the pipeline: the event's session link if it
    has one, else its device link (ADR 0004)."""
    session_profile = _links(conn, "session_id")
    device_profile = _links(conn, "anonymous_id")
    out: dict[str, str] = {}
    for e in events:
        pid = session_profile.get(e.session) if e.session is not None else None
        if pid is None:
            pid = device_profile.get(e.device)
        if pid is not None:
            out[e.event_id] = pid
    return out


def current_attachment(conn: Conn) -> dict[str, Any]:
    """Attachment, wrong attachment and the floor, for the links in core.identity_link."""
    fills = read_form_fills(conn)
    events = read_events(conn, {f.device for f in fills})
    truth = Truth(conn)
    out = attachment_metrics(linked_events(conn, events), events, truth)
    out["floor"] = floor(fills, events, truth)
    return out


def compare_rules(
    conn: Conn,
    rules: dict[str, Callable[[list[FormFill], list[Event]], dict[str, str]]] = RULES,
) -> dict[str, dict[str, Any]]:
    """Attachment and wrong attachment for every rule, and the floor, on the loaded seed."""
    fills = read_form_fills(conn)
    events = read_events(conn, {f.device for f in fills})
    truth = Truth(conn)
    out = {
        name: attachment_metrics(rule(fills, events), events, truth) for name, rule in rules.items()
    }
    out["floor"] = floor(fills, events, truth)
    return out
