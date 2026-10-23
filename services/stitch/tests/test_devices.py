"""The device rules (cdp_stitch.devices), on hand-made form fills."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from cdp_stitch.device_eval import assign_click_sessions
from cdp_stitch.devices import (
    RULES,
    Event,
    FormFill,
    conflicting_devices,
    majority,
    nearest,
    session_majority,
    session_strict,
    unanimous,
)

T0 = datetime(2025, 1, 1, tzinfo=UTC)


def fill(device: str, hours: float, profile: str, session: str | None = None) -> FormFill:
    at = T0 + timedelta(hours=hours)
    return FormFill(device=device, occurred_at=at, profile=profile, session=session)


def event(event_id: str, device: str, hours: float, session: str | None = None) -> Event:
    at = T0 + timedelta(hours=hours)
    return Event(event_id=event_id, device=device, occurred_at=at, session=session)


FILLS = [
    fill("agree", 1, "p1"),
    fill("agree", 5, "p1"),
    fill("split", 1, "p1"),
    fill("split", 10, "p2"),
    fill("two_to_one", 1, "p1"),
    fill("two_to_one", 2, "p1"),
    fill("two_to_one", 3, "p2"),
]


def test_unanimous_attaches_only_devices_whose_fills_agree() -> None:
    assert unanimous(FILLS) == {"agree": "p1"}


def test_a_device_with_fills_in_two_profiles_is_a_conflict_and_merges_nothing() -> None:
    assert conflicting_devices(FILLS) == ["split", "two_to_one"]
    # The device is left out; p1 and p2 stay separate profiles.
    assert "split" not in unanimous(FILLS)


def test_majority_needs_strictly_most_fills() -> None:
    assert majority(FILLS) == {"agree": "p1", "two_to_one": "p1"}  # "split" is a 1-1 tie


def test_nearest_assigns_each_event_to_the_closest_fill_in_time() -> None:
    events = [
        event("before_any", "split", 0),  # before the first fill → that fill
        event("near_first", "split", 4),
        event("near_second", "split", 7),
        event("after_all", "split", 20),
        event("tie", "split", 5.5),  # equidistant → the earlier fill
        event("no_fills", "elsewhere", 1),
    ]
    assert nearest(FILLS, events) == {
        "before_any": "p1",
        "near_first": "p1",
        "near_second": "p2",
        "after_all": "p2",
        "tie": "p1",
    }


def test_device_level_rules_give_every_event_its_device_profile() -> None:
    events = [event("e1", "agree", 0), event("e2", "split", 0), event("e3", "two_to_one", 9)]
    assert RULES["unanimous"](FILLS, events) == {"e1": "p1"}
    assert RULES["majority"](FILLS, events) == {"e1": "p1", "e3": "p1"}


# Sessions on "lent": the owner's two fills (p1) and the borrower's one (p2).
SESSION_FILLS = [
    fill("lent", 1, "p1", "s_owner1"),
    fill("lent", 3, "p1", "s_owner2"),
    fill("lent", 5, "p2", "s_borrow"),
    fill("own", 1, "p3", "s_own"),
    fill("tie", 1, "p4", "s_tie1"),
    fill("tie", 2, "p5", "s_tie2"),
    fill("mixed", 1, "p6", "s_mixed"),  # one session, fills in two profiles
    fill("mixed", 1.1, "p7", "s_mixed"),
]
SESSION_EVENTS = [
    event("borrow_fill_session", "lent", 4.9, "s_borrow"),
    event("owner_fill_session", "lent", 0.9, "s_owner1"),
    event("lent_no_fill", "lent", 7, "s_other"),
    event("own_no_fill", "own", 7, "s_x"),
    event("tie_fill_session", "tie", 1.9, "s_tie2"),
    event("tie_no_fill", "tie", 7, "s_y"),
    event("mixed_session", "mixed", 0.9, "s_mixed"),
    event("no_fills", "elsewhere", 1, "s_z"),
]


def test_session_majority_uses_the_sessions_fill_then_the_device_majority() -> None:
    assert session_majority(SESSION_FILLS, SESSION_EVENTS) == {
        "borrow_fill_session": "p2",  # the borrower's own fill decides, not the device majority
        "owner_fill_session": "p1",
        "lent_no_fill": "p1",  # no fill in the session → majority (p1, 2 to 1)
        "own_no_fill": "p3",
        "tie_fill_session": "p5",
        # tie_no_fill: majority is a tie → unattached
        # mixed_session: its fills disagree, and the device's majority is a tie → unattached
    }


def test_session_strict_leaves_fill_less_sessions_on_shared_looking_devices_unattached() -> None:
    assert session_strict(SESSION_FILLS, SESSION_EVENTS) == {
        "borrow_fill_session": "p2",
        "owner_fill_session": "p1",
        # lent_no_fill: "lent" has fills in p1 and p2 → unattached
        "own_no_fill": "p3",
        "tie_fill_session": "p5",
    }


def test_session_rules_are_listed() -> None:
    assert RULES["session_majority"] is session_majority
    assert RULES["session_strict"] is session_strict


def test_an_ad_click_joins_the_next_session_on_its_device_within_30_minutes() -> None:
    events = [
        event("click_near", "d1", 0, None),
        event("pv", "d1", 0.1, "s1"),
        event("click_far", "d1", 5, None),  # nothing within 30 minutes after
        event("pv_late", "d1", 6, "s2"),
        event("click_other_device", "d2", 0, None),
    ]
    sessions = {e.event_id: e.session for e in assign_click_sessions(events)}
    assert sessions == {
        "click_near": "s1",
        "pv": "s1",
        "click_far": "event:click_far",
        "pv_late": "s2",
        "click_other_device": "event:click_other_device",
    }
