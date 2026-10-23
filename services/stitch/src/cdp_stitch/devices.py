"""Device rules: which profile a device's events belong to, given its form fills.

A device (anonymous_id) is linked to people only through its form submissions,
each of which already has a profile from 01. A device never merges profiles.

  unanimous  the adopted rule (CLAUDE.md, M3): attach the device when all its
             form fills are in one profile; otherwise leave it unattached.
  majority   attach to the profile holding most of its form fills; unattached
             on a tie for most.
  nearest    per event, not per device: each event goes to the profile of the
             device's form fill nearest in time (the earlier fill on a tie).

`unanimous` is what the pipeline writes; `majority` and `nearest` are evaluated
for comparison only (`cdp-stitch device-rules`).
"""

from __future__ import annotations

from bisect import bisect_left
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class FormFill:
    device: str
    occurred_at: datetime
    profile: str


@dataclass(frozen=True)
class Event:
    event_id: str
    device: str
    occurred_at: datetime


def _profiles_by_device(fills: Iterable[FormFill]) -> dict[str, Counter[str]]:
    out: dict[str, Counter[str]] = defaultdict(Counter)
    for f in fills:
        out[f.device][f.profile] += 1
    return out


def unanimous(fills: Iterable[FormFill]) -> dict[str, str]:
    """device → profile, for devices whose form fills all share one profile."""
    return {d: next(iter(c)) for d, c in _profiles_by_device(fills).items() if len(c) == 1}


def conflicting_devices(fills: Iterable[FormFill]) -> list[str]:
    """Devices whose form fills fall in more than one profile."""
    return sorted(d for d, c in _profiles_by_device(fills).items() if len(c) > 1)


def majority(fills: Iterable[FormFill]) -> dict[str, str]:
    """device → the profile with strictly the most form fills."""
    out: dict[str, str] = {}
    for d, c in _profiles_by_device(fills).items():
        (top, n), *rest = c.most_common()
        if not rest or rest[0][1] < n:
            out[d] = top
    return out


def nearest(fills: Iterable[FormFill], events: Iterable[Event]) -> dict[str, str]:
    """event_id → profile of the device's form fill nearest in time."""
    by_device: dict[str, list[FormFill]] = defaultdict(list)
    for f in fills:
        by_device[f.device].append(f)
    for fs in by_device.values():
        fs.sort(key=lambda f: (f.occurred_at, f.profile))
    times = {d: [f.occurred_at for f in fs] for d, fs in by_device.items()}

    out: dict[str, str] = {}
    for e in events:
        device_fills = by_device.get(e.device)
        if not device_fills:
            continue
        i = bisect_left(times[e.device], e.occurred_at)
        candidates = [device_fills[j] for j in (i - 1, i) if 0 <= j < len(device_fills)]
        best = min(candidates, key=lambda f: abs((f.occurred_at - e.occurred_at).total_seconds()))
        out[e.event_id] = best.profile
    return out


def per_event(
    device_rule: Callable[[Iterable[FormFill]], Mapping[str, str]],
) -> Callable[[list[FormFill], list[Event]], dict[str, str]]:
    """Lift a device-level rule to event_id → profile."""

    def assign(fills: list[FormFill], events: list[Event]) -> dict[str, str]:
        device_profile = device_rule(fills)
        return {e.event_id: device_profile[e.device] for e in events if e.device in device_profile}

    return assign


RULES: dict[str, Callable[[list[FormFill], list[Event]], dict[str, str]]] = {
    "unanimous": per_event(unanimous),
    "majority": per_event(majority),
    "nearest": nearest,
}
