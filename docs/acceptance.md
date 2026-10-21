# Acceptance rules

**These rules, seeds and thresholds were fixed on 2026-10-20, before any data was generated.** No generator, loader or stitching code existed when this file was written. That is the point of it: the bars below can't have been chosen to fit results.

Changing a bar after seeing numbers is allowed only with a dated entry in the [change log](#change-log) that gives the reason and the numbers seen. `docs/results.md` reports results against the bars as they stood when the held-out seeds were first run.

## Seeds

| Role | Seeds | Use |
|---|---|---|
| Development | `42`, `7`, `1234` | Used to build and tune 02-specific rules: device attachment, lifecycle criteria, lead-score weights. |
| Held out | `2026`, `99`, `31337` | **Not run** until the thresholds and 02-specific rules are frozen in a tagged commit (`acceptance-frozen`). Afterwards CI runs all six, and every results table shows them marked "held out". |

Every seed generates 10,000 people with `--dob-rate 0.30`. These are the same held-out seeds that project 01 used.

01's own thresholds and weights are **not** tuned in 02; they come from its pinned tag (ADR 0001). If a 02 result seems to call for different 01 settings, the change goes into 01 under a new tag and 01 re-measures.

## Ground truth

The generator writes ground truth into the `eval` schema. The app and the dashboard never read it.

- `eval.truth_record(unit_type, unit_key, person_id, person_kind)`, one row per **unit**:
  - `unit_type ∈ {crm_contact, form_submission, device}`.
  - `unit_key` is the `crm_id`, the form event's `source_event_id`, or the `anonymous_id`.
  - Each unit belongs to exactly one person. Shared devices are not modelled; this is a stated limitation.
- `person_kind`:
  - `ordinary`: one email, one or more devices.
  - `multi_email`: form fills under two or more emails.
  - `multi_device`: two or more devices.
  - `email_changed`: two CRM contacts, different emails, same phone.

  A person has exactly one kind; when several apply, the first in this list order wins. `ordinary` is the fallback: it applies only when none of the other three do (clarified 2026-10-21, see change log).
- `eval.truth_hazard_pair(person_a, person_b, kind)`: two **different** people who look alike.
  - `same_name_relative`: same first and last name, sharing a phone or email (Jr./Sr.).
  - `shared_household_phone`: different first names, same phone.

  Each person in a hazard pair has exactly one CRM contact, so DOB presence is defined per pair: **both present**, **one missing**, or **both missing**.

**Attachable** units: CRM contacts, form submissions, and devices with at least one form submission. A device with no form fill can't be linked to anyone, so it is excluded from completeness and attachment rates.

## Identity metrics (M3)

A unit's profile comes from `core.identity_link`. "Same profile" means the same `profile_id`.

| Metric | Definition | Bar |
|---|---|---|
| **Pairwise precision** | Pairs of units in the same profile that belong to the same person ÷ all pairs of units in the same profile | **≥ 0.98 on every seed** and **≥ 0.99 mean** over the seeds reported |
| **Person completeness** | People with ≥ 2 attachable units whose attachable units all share one profile ÷ people with ≥ 2 attachable units. Computed for `ordinary`, `multi_email` and `multi_device` people; `email_changed` is reported separately | **≥ 0.80 on every seed** |
| Pairwise recall | Pairs of units in the same profile that belong to the same person ÷ all pairs of units that belong to the same person | Report only |
| **Safety** | Profiles holding two CRM contacts whose emails both exist and differ **and** whose phones both exist and differ (01's conflict rule) | **0 on every seed** |
| **Event attachment** | Web and ad events attached to a profile ÷ events whose device is attachable | **≥ 0.95 on every seed** |
| Device conflicts | Devices left unattached because their form submissions fell in different profiles | Report only |
| REVIEW queue | Pairs 01 sent to REVIEW, by rule | Report only |

### Hard-case report

Report only, per seed. A merge of a hazard pair is never counted as a win.

| Seed | Kind | Pairs | Merged, DOB both present | Merged, DOB one missing | Merged, DOB both missing |
|---|---|---:|---:|---:|---:|

"Merged" means any unit of `person_a` shares a profile with any unit of `person_b`. Each cell shows `merged / pairs in that DOB group`. Wrong merges from hazard pairs also count against pairwise precision.

`email_changed` people get their own line: completeness and the 01 rule that joined or split them.

## Data and pipeline

| Rule | Bar |
|---|---|
| Determinism | The same seed gives byte-identical generator output (SHA-256 checked) |
| Idempotent load | Running the loaders a second time changes no row count |
| Idempotent stitch | Re-stitching changes neither row counts nor the hash of the sorted list of each `profile_id` and its sorted `(id_type, id_value)` pairs |
| DOB rate | Share of CRM contacts with `dob` in 0.28–0.32 |
| Row counts (per seed, 10,000 people) | `raw.crm_contact` 6,000–8,000 · `raw.ad_click` 30,000–60,000 · `raw.web_event` 150,000–300,000 · `raw.crm_opportunity` 1,500–2,500. A count outside its range fails the run. |
| Ground-truth and form counts (per seed, 10,000 people; added 2026-10-21) | See [below](#ground-truth-and-form-counts). A count outside its range fails the run. |

### Ground-truth and form counts

Written down on 2026-10-21, before the generator existed, from its design parameters. With a different `--people`, every range scales linearly. Both the generator (on its output files) and the loader (on the database, before commit) check them. A failed check fails the run.

| Count | Range |
|---|---|
| Form submissions (`raw.web_event` where `event_name = 'form_submit'`) | 7,500–10,500 |
| `eval.truth_record`, `unit_type = 'crm_contact'` | Equal to `raw.crm_contact` |
| `eval.truth_record`, `unit_type = 'form_submission'` | Equal to the form submission count |
| `eval.truth_record`, `unit_type = 'device'` | 11,000–12,700, and equal to the distinct non-null `anonymous_id`s across `raw.web_event` and `raw.ad_click` |
| Distinct `person_id` in `eval.truth_record` | Exactly 10,000 (every person has at least one unit) |
| People by kind | `ordinary` 7,300–7,900 · `multi_email` 500–700 · `multi_device` 1,300–1,700 · `email_changed` 250–350 |
| `eval.truth_hazard_pair` | `same_name_relative` exactly 150 · `shared_household_phone` exactly 150 |
| Hazard pairs per DOB group (both present / one missing / both missing), per kind | ≥ 40 each when `0 < --dob-rate < 1` |

## Definitions and models

| Rule | Bar |
|---|---|
| Attribution sum | For every conversion and all five models, `|Σ credits − 1| ≤ 1e-9` (floats; property test) |
| No dropped conversions | A conversion with no touchpoints in the window gets `{ unattributed: 1 }` |
| Lifecycle monotonic | No profile's stage moves backward without a recorded reason |
| Won consistency | Every `won` profile has at least one opportunity with `won = true` |
| Coverage | `packages/attribution` 100% branch; `packages/marketing-logic` ≥ 90% line |

## Performance

**Measured and recorded in `docs/results.md`; CI reports them in the job summary and never fails on them.** A miss is written down as a miss, not hidden.

| Measure | Target | Where measured |
|---|---|---|
| Full seed (generate, load, stitch, score), 10,000 people | ≤ 120 s | Local (machine stated) and CI runner |
| Dashboard server render, p95 per page | ≤ 500 ms | Scripted load run against the seeded DB |
| Profile search, p95 | ≤ 200 ms | Same |

## Change log

| Date | Change | Reason | Numbers seen before the change |
|---|---|---|---|
| 2026-10-20 | Initial version | — | None (no data existed) |
| 2026-10-21 | `person_kind`: `ordinary` is the fallback when no other kind applies | Read literally, "one email, one or more devices" plus first-wins made almost no one `multi_device` | None (no generator existed) |
| 2026-10-21 | Added [ground-truth and form counts](#ground-truth-and-form-counts) | M2 needs a range for every table it writes, not only the four raw tables | None (no generator existed) |
