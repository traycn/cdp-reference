# ADR 0004: Device attachment by session, then device majority (rule d)

- **Status:** Accepted
- **Date:** 2026-10-23
- **Replaces:** the M3 device rule in CLAUDE.md ("an `anonymous_id` attaches to the profile of its form submissions when they all agree"), which is rule (a) below.
- **Bars:** `docs/acceptance.md`, event attachment ≥ 0.95 and wrong attachment ≤ 0.010 per seed (change log, 2026-10-22). Neither bar was changed by this decision.

## Context

A device (`anonymous_id`) reaches a person only through its form fills, and each fill already has a profile from 01. The question is which profile a device's web events and ad clicks belong to. The answer feeds touchpoints and attribution (M6).

Until 2026-10-22 the generator did not model shared devices. Every fill on a device belonged to the device's person, so wrong attachment was 0 by construction under every rule. The `shared_device` hazard kind (2–3% of devices; the second person in a household borrows the first person's device for some sessions and may fill forms on it) and the wrong-attachment bar were written into `docs/acceptance.md` before the generator modelled them.

## Rules compared

Implemented in `services/stitch/src/cdp_stitch/devices.py` and compared by `cdp-stitch device-rules`.

| Rule | Name in code | What it does |
|---|---|---|
| (a) | `unanimous` | The device goes to the profile of its fills when they all agree; otherwise it is unattached. |
| (b) | `majority` | The device goes to the profile with strictly the most fills; a tie leaves it unattached. |
| (c) | `nearest` | Each event goes to the profile of the device's fill nearest in time. |
| (d) | `session_majority` | A session containing a fill goes to that fill's profile. Other sessions follow (b). |
| (e) | `session_strict` | As (d), but on a device whose fills resolve to more than one profile (sharing is evident), sessions without a fill stay unattached. |

A session is `properties.session_id`. An ad click has none; it joins the session of the next web event on its device within 30 minutes (ADR 0002's inactivity gap), or is a session of its own. A session whose fills resolve to two profiles has no deciding fill and falls back to the device rule.

## The floor

**Floor:** events produced by someone other than the device's owner, in a session with no form fill, ÷ events whose device is attachable (`device_eval.floor`).

Nothing in such a session says who produced it. A rule that attaches it can only guess, and on a device whose borrower never filled a form there is no sign of sharing at all. It is above the 1.0% bar on every dev seed.

The floor counts borrowers' events only. An owner's session without a fill, on a device where only the borrower filled forms, is just as unidentifiable, and a rule that follows the fills attaches it to the borrower. Those events are wrong too but are not in the floor. This is why (a) and (e) have more wrong events than the floor on seed 7 (2,102 against 1,904), while on seeds 42 and 1234 they are at or below it. So the floor is a lower bound on the unavoidable part, not the whole of it.

## Results

Dev seeds 42, 7 and 1234, generator version 2, 01 `v1.0.0` (the pin when the decision was made). Generated from `cdp-stitch device-rules` output, not typed:

| Seed | Rule | Attachment (≥ 0.95) | Wrong (≤ 0.010) | Floor | Fragment |
|---|---|---:|---:|---:|---:|
| 42 | (a) unanimous | 0.9296 ✗ | 0.0131 ✗ | 0.0123 | 0.0108 |
|  | (b) majority | 0.9603 ✓ | 0.0153 ✗ | 0.0123 | 0.0188 |
|  | (c) nearest | 1.0000 ✓ | 0.0151 ✗ | 0.0123 | 0.0318 |
|  | (d) session + majority | 0.9692 ✓ | 0.0145 ✗ | 0.0123 | 0.0216 |
|  | (e) session, strict | 0.9492 ✗ | 0.0129 ✗ | 0.0123 | 0.0166 |
| 7 | (a) unanimous | 0.9377 ✗ | 0.0155 ✗ | 0.0132 | 0.0094 |
|  | (b) majority | 0.9653 ✓ | 0.0175 ✗ | 0.0132 | 0.0178 |
|  | (c) nearest | 1.0000 ✓ | 0.0176 ✗ | 0.0132 | 0.0309 |
|  | (d) session + majority | 0.9752 ✓ | 0.0166 ✗ | 0.0132 | 0.0204 |
|  | (e) session, strict | 0.9567 ✓ | 0.0152 ✗ | 0.0132 | 0.0149 |
| 1234 | (a) unanimous | 0.9313 ✗ | 0.0130 ✗ | 0.0121 | 0.0097 |
|  | (b) majority | 0.9595 ✓ | 0.0152 ✗ | 0.0121 | 0.0171 |
|  | (c) nearest | 1.0000 ✓ | 0.0159 ✗ | 0.0121 | 0.0313 |
|  | (d) session + majority | 0.9694 ✓ | 0.0141 ✗ | 0.0121 | 0.0203 |
|  | (e) session, strict | 0.9506 ✓ | 0.0128 ✗ | 0.0121 | 0.0156 |

The same comparison after moving the pin to 01 `v1.1.0`, from `cdp-stitch evaluate` output. The ranking, and every pass or miss against the two bars, are unchanged:

| Seed | Rule | Attachment (≥ 0.95) | Wrong (≤ 0.010) | Floor | Fragment |
|---|---|---:|---:|---:|---:|
| 42 | (a) unanimous | 0.9290 ✗ | 0.0131 ✗ | 0.0123 | 0.0120 |
|  | (b) majority | 0.9600 ✓ | 0.0153 ✗ | 0.0123 | 0.0203 |
|  | (c) nearest | 1.0000 ✓ | 0.0151 ✗ | 0.0123 | 0.0332 |
|  | (d) session + majority | 0.9689 ✓ | 0.0145 ✗ | 0.0123 | 0.0231 |
|  | (e) session, strict | 0.9488 ✗ | 0.0129 ✗ | 0.0123 | 0.0178 |
| 7 | (a) unanimous | 0.9375 ✗ | 0.0155 ✗ | 0.0132 | 0.0104 |
|  | (b) majority | 0.9651 ✓ | 0.0175 ✗ | 0.0132 | 0.0187 |
|  | (c) nearest | 1.0000 ✓ | 0.0176 ✗ | 0.0132 | 0.0319 |
|  | (d) session + majority | 0.9751 ✓ | 0.0166 ✗ | 0.0132 | 0.0213 |
|  | (e) session, strict | 0.9566 ✓ | 0.0152 ✗ | 0.0132 | 0.0158 |
| 1234 | (a) unanimous | 0.9312 ✗ | 0.0130 ✗ | 0.0121 | 0.0104 |
|  | (b) majority | 0.9595 ✓ | 0.0152 ✗ | 0.0121 | 0.0178 |
|  | (c) nearest | 1.0000 ✓ | 0.0159 ✗ | 0.0121 | 0.0320 |
|  | (d) session + majority | 0.9694 ✓ | 0.0141 ✗ | 0.0121 | 0.0209 |
|  | (e) session, strict | 0.9505 ✓ | 0.0128 ✗ | 0.0121 | 0.0163 |

## Decision rule

The following were fixed before the (d) and (e) numbers existed:

- The two bars (`docs/acceptance.md`, 2026-10-22).
- The rule for choosing: if exactly one rule passes both bars, adopt it; if several pass, adopt the one with the lowest wrong attachment; if none passes, stop and report.
- That a bar is not changed after seeing numbers without a dated change-log entry.

No rule passed both bars, and the floor is above 1%. Applying the rule on 2026-10-23, after the numbers:

- The wrong-attachment bar **stays at 1.0%** and is reported as a miss on every seed, with the floor beside it.
- Among rules that clear the attachment bar on all three dev seeds, the one with the lowest wrong attachment is adopted.

Choosing among non-passing rules by attachment first and wrong attachment second was settled on 2026-10-23, after the (d) and (e) numbers were seen. It extends the earlier "lowest wrong attachment" rule to the case where nothing passes; no bar changed.

## Decision

**Rule (d), `session_majority`.**

- (b), (c) and (d) clear 0.95 attachment on all three seeds. Of these, (d) has the lowest wrong attachment on every seed.
- **(e) is the recorded alternative, not adopted.** Its wrong attachment is lower than (d)'s on every seed and equal to (a)'s: every event it gets wrong is one that no fill identifies. But it misses the attachment bar on seed 42 (0.9492 under `v1.0.0`, 0.9488 under `v1.1.0`).
- (a) misses attachment on every seed and has the same wrong attachment as (e).

## How the pipeline writes it

Migration `004_session_links.sql` adds `session_id` to `core.identity_link`, unique like the other units.

- One `session_id` link (source `session`) per session with a deciding fill.
- One `anonymous_id` link (source `device`) per device with a majority profile.
- **An event's profile** is its session's link if it has one, else its device's link. M6 builds touchpoints the same way, including the 30-minute rule for ad clicks.
- A device with a tie for most fills gets no device link and is counted as a device conflict; its fill sessions still attach.
- Confidence stays 1.0 (ADR 0001). A majority is a deterministic rule, not a probability; the cost of its guess is measured by wrong attachment.

## Consequences

- **Known cost: a borrowed session without a form fill goes to the device's majority profile, usually the owner's.** These events are the floor. They are why wrong attachment misses the 1.0% bar on every dev seed, and they will be reported as a miss in `docs/results.md`, next to the floor.
- On a device where sharing is evident, (d) also guesses for sessions without a fill. (e) would leave those unattached. This is the 300–400 events per seed by which (d)'s wrong attachment exceeds (e)'s.
- Fragment rate (attached events of a person with a CRM contact, on a profile without that contact) is about 2% under (d), against about 1% under (a). (d) attaches more of the sessions whose fills 01 kept apart from the person's contact, so it carries more of that split into events.
- The comparison stays in `cdp-stitch evaluate` output, so `docs/results.md` reports all five rules for every seed.
