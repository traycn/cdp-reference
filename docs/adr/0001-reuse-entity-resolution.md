# ADR 0001: Reuse project 01's entity resolution as a pinned Python package

- **Status:** Accepted
- **Date:** 2026-10-20
- **Context repo:** [github.com/traycn/entity-resolution](https://github.com/traycn/entity-resolution) (project 01)

## Context

02 must stitch identities across CRM contacts, web form fills and anonymous devices. Project 01 already has measured matching rules: 0.9998 mean pairwise precision over six seeds, three of them held out, plus a safety rule that never merges conflicting identifiers. The portfolio claim is stronger if 02 uses **the same engine** rather than a lookalike.

Constraints:

- 02 is a TypeScript monorepo.
- 01 is Python 3.12 (`polars`, `rapidfuzz`, `phonenumbers`), with a CLI (`resolver run --sources DIR --out DIR`) and importable functions (`score_pair`, `cluster_matches`).

## Options

### A. Install 01 as a Python package pinned to a git tag, call it from a pipeline step — **chosen**

`services/stitch/` is a `uv` project that depends on 01 at tag `v1.0.0`. One stitching run:

1. Exports person records from `staging` into 01's CSV format.
2. Runs `resolver`.
3. Loads clusters and per-pair evidence back into `core.identity_link` and `core.link_evidence`.

### B. Run 01 as a small HTTP service — rejected

- Adds an image build, health checks, an HTTP contract, timeouts and retries, for work that is a batch job over ~10k records.
- CI would have to build and start the service before every stitching test.
- Reproducibility depends on image tags as well as code tags.
- It would read as over-engineering to a reviewer, and it proves nothing that A doesn't.

### C. Port the scoring rules to TypeScript — rejected

- Creates a second copy of every normalizer and rule, so 01 stops being the single source of truth and fixes must land twice.
- Proving the port matches 01 needs a cross-check that runs 01 anyway, so the Python toolchain is still needed in CI.
- Weakens the portfolio claim from "the measured engine" to "a reimplementation of it".

## Decision

**Option A.** Requirements:

- **Prerequisite in the 01 repo (separate session, before M3):**
  - Ship `config.toml` inside the package, with `RESOLVER_CONFIG` as an override. Today `DEFAULT_CONFIG_PATH` is `parents[2] / "config.toml"`, which a wheel install can't find.
  - Rename the distribution from the generic `resolver` (e.g. to `entity-resolution`); the import name stays `resolver`.
  - Tag `v1.0.0`; 01 has no tags today.
- `services/stitch/uv.lock` pins that tag. Upgrading 01 is a deliberate change to the pin, followed by a re-run of `docs/acceptance.md`.
- 02 does **not** tune 01's thresholds or weights. Any change goes into 01, is re-measured there, and is tagged.
- Exact email and phone matches go through 01's `exact_id` rule, not SQL equality, so the first-name gate, the DOB guard and the conflict split all apply. SQL handles only structural links: opportunity → `crm_id`, form submission → its own `anonymous_id`.

## Which 01 rules fire on 02's fields

These are the person records sent to 01:

| 01 column | From CRM contact | From form submission |
|---|---|---|
| `record_id` | `crm:<crm_id>` | `form:<source_event_id>` |
| `source` | `crm` | `web_form` |
| `first_name`, `last_name` | yes | yes (form properties) |
| `email` | yes | yes |
| `email_verified` | yes (added in M1) | no (empty) |
| `phone` | yes | optional |
| `address`, `city`, `state`, `zip` | yes (added in M1) | no |
| `dob` | 30% of contacts (configurable) | no |
| `updated_at` | `updated_at`, as the UTC day | `occurred_at`, as the UTC day |

`company` and `title` aren't 01 inputs, so they are not exported.

The rules, as read from 01's `scoring.py`, `blocking.py` and `merge.py` before tagging:

| 01 rule / stage | Fires in 02? | Notes |
|---|---|---|
| Normalizers (name + nicknames, email gmail dots/`+tag`, E.164 phone, address, date) | **Yes** | Every person record goes through them. |
| Blocking: email local part | **Yes** | Contacts and form submissions. |
| Blocking: phone last 7 | **Yes, partly** | All contacts; only forms where the generator collects phone. |
| Blocking: name Soundex + ZIP | **Contacts only** | Forms have no ZIP, so a form fill reaches its contact only through email or phone. |
| Safety rule: conflicting email **and** phone → `NO_MATCH` (`conflict`) | **Yes** | Needs both identifiers on both records. Pairs where a form has no phone can never hit it. |
| `exact_id` → MATCH when first names agree (Jaro-Winkler ≥ 0.80) | **Yes** | The main merge path in 02. |
| `exact_id_no_name` → REVIEW | **No** | Needs a record without a first name; the generator always fills it. Fired 0 times on the three dev seeds. |
| `shared_identifier` → REVIEW (first names disagree) | **Yes** | `shared_household_phone` hazard pairs should land here. |
| `exact_id_dob_mismatch` → REVIEW | **Only contact–contact pairs with both DOBs** | With 30% DOB coverage, about 9% of contact pairs have both DOBs. Forms never carry DOB. The guard is pairwise, so a form submission can bridge the pair it sent to REVIEW (see [bridge records](#bridge-records-defeat-the-dob-guard)). |
| Missing-DOB gap (identical names, DOB missing → MATCH) | **Yes, deliberately** | `same_name_relative` pairs with a DOB missing merged in every case on the dev seeds (100 of 100 per seed). Reported in the hard-case table, split by DOB presence. |
| `exact_id_other_mismatch` → REVIEW | **Yes** | Contact–contact pairs; form–contact pairs only when the form has a phone. |
| Weighted score (email 0.35, phone 0.25, name 0.25, address 0.15) | **Yes, never auto-merges** | `allow_weighted_match = false` in 01. It only chooses REVIEW or NO_MATCH. Address counts only on contact–contact pairs. |
| `weighted_low_evidence`, `weighted_id_mismatch`, `weighted_match_disabled` | **Yes** | REVIEW reasons only. |
| Conflict-aware clustering (split components containing a conflict pair) | **Yes, but never split on the dev seeds** | Applies to every MATCH-connected component, including those formed through form submissions. Only conflicting email **and** phone count as a conflict; a REVIEW pair is not kept apart. |
| Survivorship: verified first, then most recent; field groups kept whole | **Yes, contacts dominate** | Forms have `email_verified` empty, so a verified contact always outranks them. 02 uses 01's golden record for the profile's name, email and phone (see below). Recency is compared by day. |
| Audit log and `unmerge` | **Available, unused at first** | `link_evidence` keeps the pair evidence. Exposing undo in 02 is out of scope until after M7. |
| Review UI / `apply-review` | **No** | 02 has no human review loop. REVIEW pairs stay unmerged and are counted. |
| `city`, `state` | **Not scored** | 01 scores only the `address` (street) field and uses `zip` only for blocking. They're exported anyway so survivorship keeps the address group whole. |

### Confirmed at M3 (2026-10-22)

These were open until 01 `v1.0.0` (commit `df0287a`) ran on 02's output, on dev seeds 42, 7 and 1234.

- **How 01 is called.** `services/stitch` calls 01's own `run` command function (`resolver.cli.run`) in-process, unchanged. It is the same code path as `resolver run --sources DIR --out DIR`. 02 reads 01's output files: `clusters.csv`, `golden.csv`, `audit.jsonl`, `splits.jsonl` and `review.jsonl`.
- **One combined CSV.** Confirmed. CRM contacts and form submissions go into a single `person_records.csv`. 01 reads every column as a string, and an empty field is null, so form rows with empty `dob`, `address`, `city`, `state`, `zip` and `email_verified` load as missing values.
- **`updated_at` is sent as the UTC day (`YYYY-MM-DD`).** 01's `normalize_date` parses dates, not timestamps. A full ISO timestamp would parse as missing, and survivorship would silently lose its "most recent" step. As a result, recency is compared by day, and two records updated on the same day fall back to 01's `record_id` order.
- **`confidence` in `core.identity_link` is 1.0 for every link.** Every link comes from a deterministic rule:
  - 01's `exact_id` (with `allow_weighted_match = false`, nothing else auto-merges);
  - a foreign key (opportunity → `crm_id`);
  - a session's own form fill, or a device's majority of form fills (rule (d), ADR 0004; until 2026-10-23, a device whose form submissions all agree).

  01's `score` is a weighted similarity, not a probability, so it stays in `core.link_evidence.score` and is not copied into `confidence`. The column is kept for a future probabilistic source.
- **Runtime.** Small, as expected. Each dev seed has about 15.8k person records (about 7k contacts and 8.8k form submissions). The 01 step takes about 2.3 s, and the whole stitch run (export, resolve, load) about 4 s, on a local Apple-silicon laptop. Measured numbers will be reported in `docs/results.md`.
- **`exact_id_no_name` never fires** (0 on every dev seed), because every record has a first name.
- **Golden record.** The profile's `full_name`, `primary_email` and `primary_phone` come from 01's golden record.
  - `company` isn't a 01 field. It is taken from the record that supplied the golden name, so it stays consistent with the name.
  - `lifecycle_stage` and the other profile fields are 02's own (M4).
- **Link evidence and the `SPLIT` name.** Confirmed: `SPLIT` is 02's label for a MATCH edge listed in 01's `splits.jsonl` under `rejected_edges`. 01 describes these as edges cut when a component is "split by the conflict check". The `rule` column keeps the edge's original 01 rule, e.g. `exact_id`.
  - `MATCH` rows are the edges kept inside a cluster (`audit.jsonl`), and `REVIEW` rows come from `review.jsonl`.
  - 01's CLI doesn't write NO_MATCH pairs, so `link_evidence` has none.
  - No component was split on any dev seed, so there are 0 `SPLIT` rows.
- **Opportunity links needed a schema change.** `core.identity_link.id_type` had no value for opportunities. Migration `002_opportunity_links.sql` adds `opp_id`, unique like the other units.

### Bridge records defeat the DOB guard

This wasn't anticipated above. It is the main identity finding of M3.

- 01 sends a same-name pair with differing DOBs to REVIEW (`exact_id_dob_mismatch`). It does so correctly, but only for that pair.
- A form submission carries no DOB. When a Jr. and Sr. share an email or a phone, a form with that identifier and the same name matches **both** contacts by `exact_id`.
- 01's clustering keeps apart only pairs whose email and phone both conflict. The REVIEW pair is joined through the form.
- Example, seed 42 (P00085 / P04488):
  - C000335–C004041: REVIEW, `exact_id_dob_mismatch`.
  - Forms W0009174 and W0121582 carry only an email. Each has a MATCH (`exact_id`) with both contacts, so the two contacts end up in one cluster.
- On the dev seeds, 39, 35 and 37 of the 50 `same_name_relative` pairs with **both** DOBs present merged this way. The pairs with one or both DOBs missing merged in every case. These merges are the only wrong merges on the dev seeds, and they are why pairwise precision is about 0.955.
- **Fix, made in 01 `v1.1.0` (commit `7623a03`):** `exact_id_dob_mismatch` pairs are hard cannot-links in conflict-aware clustering, so a bridge record can't join them. It was re-measured in 01. 02 moved its pin to `v1.1.0` on 2026-10-23 and doesn't work around it locally.
- **After the fix,** on the dev seeds, the two CRM contacts of a `same_name_relative` pair with both DOBs present are never in one profile. The DOB-less form submission that bridged them now joins only one of the two contacts, and nothing on the form says which. In 9, 10 and 9 pairs (seeds 42, 7, 1234) at least one relative's form sits with the other relative's contact. Each such form carries the same name and the shared email, and no phone. The acceptance bar counts any shared unit as a merge, so these pairs still count as merged.

## Consequences

- From M3 on, the stitch step, the `stitch-eval` CI job and `pnpm seed` need Python 3.12 and `uv`.
- 02's identity numbers depend on a pinned version of 01. `docs/results.md` must name the tag.
- 01's known limitations carry over, and 02 must report them rather than hide them:
  - same-name relatives with a missing DOB can merge;
  - **a form fill that matches both relatives.** Since `v1.1.0`, same-name relatives with both DOBs present keep separate contacts. A form fill carries no DOB, though. One with their shared name and shared email or phone matches both contacts by `exact_id`, and the cannot-link lets it join only one, with nothing on the form to say which. When it joins the wrong relative, that relative's profile holds the other's form (and, through rule (d), its session's events). `docs/acceptance.md` counts this as a merge of the pair, so the bar "0 same-name pairs with both DOBs present merged" is a known miss, reported in `docs/results.md` with a breakdown (contact-to-contact merges, expected 0; merges only through form fills, with the forms involved);
  - household members with similar first names sharing a phone can merge;
  - identity drift where a person changes both phone and email stays split.
