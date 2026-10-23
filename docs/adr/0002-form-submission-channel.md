# ADR 0002: Form submissions are not touchpoints; in-session page views keep the session's channel

- **Status:** Accepted
- **Date:** 2026-10-22
- **Settles:** the M3 open decision in CLAUDE.md ("which channel a form submission gets"). Implemented in M4 (channel definition and parity test) and M6 (touchpoints). Nothing in M3 builds touchpoints.

## Context

A touchpoint is a marketing contact that attribution can credit with a channel. `core.touchpoint` is built from `raw.web_event` and `raw.ad_click`. Two kinds of web event get a misleading channel from `staging.web_event` today:

1. **Form submissions.** `form_submit` events carry no referrer and no UTM tags, so `staging.channel_for` labels them `direct`. The generator places every form fill at the end of a session, after its last page view, with the same `properties.session_id` as that session's page views.
2. **Page views after the first in a session.** Their referrer is the previous page on our own site (`https://www.northbeam-cdp.example/...`). `staging.channel_for` has no idea which host is ours. Rule 4 (no tags, non-search referrer) labels them `referral`.

The second problem is much larger than the first. On dev seed 42 (`SELECT event_name, channel, referrer LIKE 'https://www.northbeam-cdp.example%' AS internal, count(*) FROM staging.web_event GROUP BY 1, 2, 3`), 145,735 of the 150,430 page views labelled `referral` have an internal referrer. That is 97% of them, and 69% of all 212,157 page views. Left alone, `referral` would dominate every multi-touch model.

Options for form submissions (from CLAUDE.md):

- **A. Not touchpoints.** They are person records (identity, M3) and the trigger for conversions such as MQL (M4), not marketing contacts.
- **B. Inherit the channel of the session's entry page view.**

## Decision

**1. Form submissions are not touchpoints (option A).**

- The session that contains the form already has a touchpoint: its entry page view carries the session's channel. Under B the same visit would be credited twice. Linear, time-decay and position-based models would over-weight sessions that end in a form, purely because they ended in a form.
- A form fill is usually the event that makes a profile reach MQL. If it were also a touchpoint, it would sit at, or seconds before, the conversion's `occurred_at`. Last-touch and time-decay would then credit the conversion largely to itself.
- B would copy the entry channel onto the form, which adds no information that the entry page view doesn't already provide.

**2. A page view whose referrer is our own site continues the session's channel and is not `referral`.**

- A session's channel is decided once, by its entry event, using the existing rules (UTM medium, then referrer, then `direct`).
- Every later event in the same session gets that channel. Our own host is never a referral source.
- Sessions are identified by `properties.session_id`, which the generator writes on every `page_view` and `form_submit`. Real data without a session ID would sessionize by device and a 30-minute inactivity gap. That is out of scope while all feeds are synthetic.
- An internal referrer on a session's first event (a session with no external entry) gets `direct`. The generator never produces this case, but the rule is written down so the SQL and TypeScript agree on it.

## Consequences

- **M4.**
  - `definitions.ts` and the staging SQL both need the site host and the session-continuation rule.
  - The parity test's shared case table gets internal-referrer cases: with and without an entry event, and with tags on the entry event.
  - `staging.channel_for` stays a pure function of a single event. Session continuation is a window over `session_id` in `staging.web_event`, or in the M6 touchpoint builder; that choice is M4's.
- **M6.**
  - `core.touchpoint` excludes `event_name = 'form_submit'`.
  - Form submissions still matter for attribution as conversion triggers (`core.conversion`, `kind = 'mql'`), and as the link that attaches a device to a profile (M3).
- **Left open for M6 (not decided here):**
  - **Whether each page view is a touchpoint, or only the session's entry event.** With decision 2, every page view in a session carries the same channel. Counting all of them weights linear and time-decay credit by session length, not by number of visits. I lean toward one touchpoint per session (its entry event), but this needs its own decision.
  - **Ad clicks and their landing page views describe the same visit.** The click is in `raw.ad_click`; the landing page view, with the same UTM tags, is in `raw.web_event`. Counting both credits a paid visit twice.
- `docs/definitions.md` (M4) explains both rules next to the channel table.
