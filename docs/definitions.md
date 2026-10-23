# Definitions

What the words mean in this project. The code is in `packages/marketing-logic/src/definitions.ts`; the channel rules also exist in SQL (`staging.channel_for` and `staging.web_event`, migration `005_channel_site_host.sql`). A test runs the same table of cases through both and fails if they differ.

These definitions are fixed for M4. Nothing here was tuned against results.

## Channels

Every touch of the site or an ad has one channel: `paid_search`, `paid_social`, `organic`, `email`, `referral`, `direct` or `unattributed`.

### One event

Rules are applied in order; the first that fits decides.

| # | If the event has… | Channel |
|---|---|---|
| 1 | a `utm_medium` we recognize (table below) | the channel in the table |
| 2 | UTM tags (`utm_source` or `utm_medium`) we don't recognize | `unattributed` |
| 3 | no tags and no referrer | `direct` |
| 4 | no tags and a referrer on our own site | `direct` |
| 5 | no tags and a referrer from a search engine (Google, Bing, DuckDuckGo, Yahoo, Ecosia, including subdomains and any country domain) | `organic` |
| 6 | no tags and any other referrer | `referral` |

Tags are compared after trimming spaces and lowercasing. Blank tags count as missing. Only plain spaces are trimmed, not tabs, which matches Postgres `btrim`. Tags always beat the referrer.

| `utm_medium` | Channel |
|---|---|
| `cpc`, `ppc`, `paid_search`, `sem` | `paid_search` |
| `paid_social`, `paidsocial`, `social_paid`, `cpm` | `paid_social` |
| `email`, `e-mail`, `newsletter` | `email` |
| `organic`, `social`, `organic_social` | `organic` |
| `referral` | `referral` |

Why `unattributed` exists: a tag we don't know, such as `utm_medium=print`, is a real marketing contact. Calling it `direct` would hide it, and guessing a channel would invent one.

**Our own site** is `northbeam-cdp.example` and every subdomain. A visitor moving between our pages is not being referred by anyone, so such a referrer is never `referral` (rule 4). Hosts that only look similar (`northbeam-cdp.example.evil.example`, or our name in a query string) are other sites.

### A session

A session's channel is decided once, by its first event (earliest time; if two share a time, the smaller event id). Every event of the session gets that channel, whatever its own referrer or tags say. This is [ADR 0002](adr/0002-form-submission-channel.md), decision 2. Without it, 97% of the page views that rules 1–6 call `referral` on seed 42 were really visitors clicking from one of our pages to another.

- A session whose first event has an internal referrer (no external entry) is `direct`.
- Events with no `session_id` are judged alone.
- This applies to all web events including form submissions. Form submissions are still not touchpoints (ADR 0002, decision 1), which is M6's job to enforce.

### Ad clicks

A tagged click is judged by rules 1–2 on its tags. An untagged click is still paid, so its platform decides: `google_ads` → `paid_search`, `meta` and `linkedin` → `paid_social`, anything else → `unattributed`.

### Not decided here

Whether every page view is a touchpoint or only a session's first, and how an ad click and its landing page view are credited together. Both stay open for M6 (ADR 0002). Nothing in this file depends on the answer.

## Lifecycle stages

A profile has exactly one stage: **Lead → MQL → SQL → Opportunity → Won**. Its stage is the highest one whose criterion it meets. A profile need not pass through every stage: a CRM contact with no form fill and a qualified opportunity is an SQL and was never an MQL.

| Stage | Criterion | Where the facts come from |
|---|---|---|
| **Lead** | Every profile. | — |
| **MQL** (marketing qualified) | At least one form submission. | `staging.form_submission` linked to the profile |
| **SQL** (sales qualified) | At least one opportunity at stage `qualification`. | `staging.crm_opportunity` |
| **Opportunity** | At least one opportunity at stage `proposal` or `negotiation`. Also `closed_won` where `won` is not true (a data fault, kept visible instead of counted as a win). | same |
| **Won** | At least one opportunity at stage `closed_won` **and** `won = true`. | same |

How each opportunity stage is read:

| CRM stage | Proves |
|---|---|
| `prospecting` | Nothing. An early conversation isn't a qualified one. |
| `qualification` | SQL |
| `proposal`, `negotiation` | Opportunity |
| `closed_won` and `won = true` | Won |
| `closed_lost` | Nothing. The CRM only keeps a deal's final stage, so a loss doesn't say how far it got. |
| any other name | Nothing |

With several opportunities, the furthest one counts. A lost deal never lowers a profile that has another deal further along.

### MQL

The MQL criterion is **the profile's first form submission**, and that moment (`occurred_at` of the earliest form fill) is also the time of its `mql` conversion. There is no lead-score threshold: the criterion is independent of M5, so changing score weights can never change who is an MQL or when. This was chosen by the project owner at the start of M4. Because the set of `mql` conversions feeds attribution (M6), changing this criterion later changes what M6 counts and needs a new decision.

### Stages only move forward

A stage can go down only with a recorded reason. `advanceStage(current, computed, reason?)` gives three outcomes: the new stage is higher or equal and is applied; it is lower and has a reason, and is applied and returned with the reason to store; it is lower with no reason (or a blank one), and the current stage is **kept** and the attempt reported as `held`. `unrecordedRegressions(history)` finds any backward step in a stored history that has no reason.

The rule is stored in the database. `core.customer_profile.lifecycle_stage` is the current stage and `core.lifecycle_history` holds every stage a profile has had, in order (`seq` 1 is the first recorded). A trigger refuses a history row that is lower than the one before it unless it has a non-blank reason, so no code path can record a backward move silently. The materializer never writes one: when the facts now give a lower stage than the profile has (for example after a re-stitch), the profile keeps its stage and the run counts and reports it as a held backward attempt. Loading a new dataset is different: `materialize --new-dataset` starts every profile again from its facts, because a different dataset is a different set of people who happen to reuse profile ids.

### Won consistency

Every Won profile has at least one opportunity with `won = true`. `wonWithoutWonOpportunity` checks it. It holds by construction in `lifecycleStage`. It is also checked on database rows after every run, to catch stages written some other way and held stages whose evidence has gone.

## Conversion kinds

| Kind | One row per | `occurred_at` | `revenue` |
|---|---|---|---|
| `won` | won opportunity | `closed_at` | `amount` |
| `mql` | profile that reaches MQL | the first form submission | 0 |

## Where it is written

`services/lifecycle` (`node cli.ts run`) reads each profile's form submissions and opportunities through `core.identity_link` and `staging`, applies the functions in `definitions.ts`, and writes:

- `core.customer_profile.lifecycle_stage`, the current stage;
- `core.lifecycle_history`, the stage history;
- `core.conversion`: `mql:<profile_id>` at the profile's first form submission, and `won:<opp_id>` for each opportunity that is `closed_won` with `won = true`, dated at `closed_at` with `amount` as revenue. A won opportunity with no `closed_at` can't be dated and is counted in the run output instead of written.

`scripts/seed.sh` runs it after stitching. Running it again on the same data writes nothing: rows are updated only when a column differs, and conversions that no longer hold are deleted. `node cli.ts verify` re-runs it, compares row counts and hashes of the conversions and of the stages and history, and checks the rules above on the rows; CI runs it for each development seed.
