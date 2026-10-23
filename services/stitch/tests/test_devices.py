"""The device rules (cdp_stitch.devices), on hand-made form fills."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from cdp_stitch.devices import (
    RULES,
    Event,
    FormFill,
    conflicting_devices,
    majority,
    nearest,
    unanimous,
)

T0 = datetime(2025, 1, 1, tzinfo=UTC)


def fill(device: str, hours: float, profile: str) -> FormFill:
    return FormFill(device=device, occurred_at=T0 + timedelta(hours=hours), profile=profile)


def event(event_id: str, device: str, hours: float) -> Event:
    return Event(event_id=event_id, device=device, occurred_at=T0 + timedelta(hours=hours))


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
