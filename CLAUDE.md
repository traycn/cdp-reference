# CLAUDE.md — Reference Customer 360 / CDP

## Goal
A vendor-neutral Customer 360 that ingests synthetic ad, web-event and CRM feeds into PostgreSQL, stitches identities into unified profiles, scores leads, and compares attribution models in a Next.js dashboard. Deployed to cloud with Terraform.

It is the public, inspectable version of the portfolio's Zoho-based Customer 360, plus lead scoring, attribution and MQL definitions.

## Constraints
- pnpm monorepo, TypeScript strict everywhere except `services/stitch/` (Python 3.12 glue around project 01; `uv`, `ruff`, `mypy --strict`).
- PostgreSQL 16; migrations are plain SQL in `db/migrations`, applied with `dbmate` (run from a `dbmate` service in `docker-compose.yml`, so no local install is needed).
- Identity stitching reuses project 01 as a Python package pinned to a git tag, not a port. Decision and the list of 01 rules that actually fire on 02's fields: `docs/adr/0001-reuse-entity-resolution.md`.
- `packages/attribution`: pure attribution functions, **100% branch coverage** (vitest).
- `packages/marketing-logic`: lifecycle definitions, channel mapping and lead scoring, **≥ 90% line coverage** (vitest). It may import types from `packages/attribution`, never the reverse.
- Acceptance rules, seeds and thresholds are frozen in `docs/acceptance.md`. Don't change a threshold after seeing results without a dated entry in its change log.
- Infra: Docker Compose for local. Cloud is decided at M8 (see M8); record it in an ADR.
- No real PII. All feeds come from `services/ingest/generate.ts`.

## Layout
```
db/migrations/              # SQL schema (raw → staging → core, plus eval)
services/ingest/            # synthetic feed generator + loaders (TS)
services/stitch/            # uv project: export → resolver (01, pinned tag) → load links (Python)
packages/attribution/       # pure TS attribution models
packages/marketing-logic/   # definitions.ts, channel mapping, lead scoring
apps/dashboard/             # Next.js App Router
infra/terraform/            # cloud deploy
docs/                       # acceptance.md, definitions.md, results.md, architecture.md, adr/
.github/workflows/ci.yml
docker-compose.yml
```

## Schema notes (apply in M1 `001_init.sql`)
- **Layers.** `raw` (as delivered), `staging` (typed, normalized views over raw: lowercased email, E.164 phone, UTM → channel), `core` (unified model), `eval` (ground truth; written by the generator, never read by the app or dashboard).
- **Load metadata.** Every `raw.*` table gets `loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()` and `batch_id TEXT NOT NULL`. Loaders upsert on the source key, so reruns don't add rows. Freshness on the Data quality page reads `max(loaded_at)`.
- **CRM contact fields.** `raw.crm_contact` adds `address`, `city`, `state`, `zip`, `email_verified BOOLEAN`, and `dob DATE`. The generator fills `dob` for a configurable fraction of contacts (default 0.30) so 01's missing-DOB limitation is exercised and reported.
- **Form fields.** `form_submit` events carry `first_name`, `last_name`, `phone` (optional) and `company` in `properties`, so form submissions can be scored as person records alongside CRM contacts.
- **Deterministic profile IDs.** `core.customer_profile.profile_id` is a UUIDv5 of a fixed namespace and the smallest member key in the cluster (e.g. `crm:C000123`), not `gen_random_uuid()`. The same input then always gives the same IDs, and rebuilding the database doesn't break dashboard links.
- **Identity links.** In `core.identity_link`, `(id_type, id_value)` can't be the primary key: a shared household phone legitimately belongs to two profiles. Make the PK `(profile_id, id_type, id_value)`, with a unique partial index on `(id_type, id_value)` for `crm_id`, `form_submission` and `anonymous_id`.
- **Link evidence.** `core.link_evidence (left_key, right_key, decision, rule, score, field_scores JSONB, engine, engine_version, run_id)` keeps every pair decision from 01 (MATCH, REVIEW, conflict splits), so a profile is explainable the way 01's merges are.
- **Touchpoints.** `core.touchpoint` gets `UNIQUE (source_table, source_id)`.
- **Conversions.** `core.conversion (conversion_id, profile_id, kind, occurred_at, revenue, source_id)`:
  - `kind = 'won'`: one row per won opportunity. `occurred_at = closed_at`, `revenue = amount`.
  - `kind = 'mql'`: one row per profile reaching MQL. `occurred_at` = when the criterion was first met, `revenue = 0`.
- **Channels.** The full channel set is `paid_search | paid_social | organic | email | referral | direct | unattributed`.
- **Lead score.** `core.lead_score` stays as is; the score inputs come from `packages/marketing-logic`.

## CI (`.github/workflows/ci.yml`, starts in M1)
`ubuntu-24.04`, pinned action versions, runs on every push and PR. Each job is added in the milestone shown:

| Job | Added | What it does |
|---|---|---|
| `lint-typecheck` | M1 | `pnpm install --frozen-lockfile`, eslint, prettier --check, `tsc --noEmit` |
| `migrate` | M1 | Postgres 16 service; `dbmate up`, `dbmate rollback` + `up` again, schema dump diffed against `db/schema.sql` |
| `test` | M2 | vitest across the workspace; coverage gates as in Constraints |
| `seed-idempotency` | M2 | Seed the dev seeds twice; fail if any row count or the profile hash changes, or a count falls outside `docs/acceptance.md` ranges |
| `stitch-eval` | M3 | `uv sync --locked` in `services/stitch`, then stitch and run the `docs/acceptance.md` SQL checks; fail below thresholds |
| `reproduce` | M3 | Regenerate `docs/results.md`; fail if it differs from the committed copy (timings excluded) |
| `perf-report` | M7 | Measure the performance numbers in `docs/acceptance.md` and post them to the job summary. **Reports only; never fails.** |
| `build` | M7 | `next build`, start the server, request every page |
| `terraform` | M8 | `fmt -check`, `validate`, `tflint`, `plan` on PRs via OIDC (no long-lived keys) |

## Milestones

### M1 — Schema, local stack, CI
- Finish `001_init.sql` per Schema notes. `docker compose up -d` gives Postgres, adminer, and a `dbmate` service.
- pnpm workspace skeleton (`packages/*`, `services/*`, `apps/*`); CI jobs `lint-typecheck` and `migrate`.
- **Accept:** `dbmate up` succeeds on a clean DB, and `rollback` + `up` succeed too; CI is green.

### M2 — Synthetic feeds, ground truth, loaders
- Generate 10,000 people per seed with realistic journeys: ad clicks (UTM params), web sessions, form fills, and CRM contacts and opportunities with stages and amounts. Some people use multiple emails or devices. `generate.ts --seed N --people 10000 --dob-rate 0.30`.
- **Ground truth is a deliverable:** `eval.truth_record` and `eval.truth_hazard_pair`, with the kinds defined in `docs/acceptance.md` (multi-email, multi-device, email changed, same-name relative, shared household phone).
- Loaders write to `raw.*` idempotently.
- **Accept:** the same seed produces byte-identical output (hash checked); row counts are printed and fall inside the `docs/acceptance.md` ranges; reruns are no-ops. CI: `test`, `seed-idempotency`.

### M3 — Identity stitching → `core.customer_profile`
- **Prerequisite (separate session, in the 01 repo):** 01 ships its config inside the package with a `RESOLVER_CONFIG` override, renames its distribution (e.g. `entity-resolution`; import stays `resolver`), and is tagged `v1.0.0`. `services/stitch` pins that tag in `uv.lock`.
- **Person records** are CRM contacts and form submissions. They are exported in 01's input format and resolved by `resolver` at the pinned tag. Exact email and phone matches go through 01's `exact_id` rule (first-name gate, DOB guard, conflict split), **not** raw SQL equality, because equality chained in SQL would bypass 01's safety rule.
- **Structural links** are done in SQL with confidence 1.0: opportunity → `crm_id`, form submission → its own `anonymous_id`.
- **Devices.** An `anonymous_id` attaches to the profile of its form submissions when they all agree. A device whose submissions fall in two profiles stays unattached and is counted (`device_conflict`). A device never merges profiles.
- Write `core.identity_link` (source, confidence) and `core.link_evidence`. Which 01 rules fire on these fields: ADR 0001.
- **Decided: form submissions are not touchpoints**, and an in-session page view with the site's own URL as referrer continues the session's channel instead of counting as `referral`. Reasons and what M4/M6 must implement: `docs/adr/0002-form-submission-channel.md`.
- **Accept:** the `docs/acceptance.md` identity metrics — precision, completeness, safety, hard-case report — on the dev seeds, then on the held-out seeds after thresholds are frozen. CI: `stitch-eval`, `reproduce`.

### M4 — Definitions
- `packages/marketing-logic/src/definitions.ts`:
  - Lifecycle stages (Lead → MQL → SQL → Opportunity → Won) with explicit criteria.
  - The UTM → channel mapping, including `referral` and `unattributed`.
  - The conversion kinds (`won`, `mql`).
- A parity test that runs a shared table of UTM/referrer cases through both the staging SQL channel function and definitions.ts and fails on any difference.
- `docs/definitions.md` explains each threshold; this mirrors the "Pipeline & Definition Consolidation" claim.
- **Accept:** stages only move forward unless a recorded reason says otherwise; every Won profile has an opportunity with `won = true`; tests for each stage boundary.

### M5 — Lead scoring
- `packages/marketing-logic`: rule-based fit + engagement score, with decay and configurable weights. Output into `core.lead_score`.
- **Accept:** unit tests for each rule and for decay; ≥ 90% line coverage.

### M6 — Attribution models
- `packages/attribution/src/attribution.ts`: first-touch, last-touch, linear, time-decay, position-based (40/20/40). Credits are floats.
- A conversion's touchpoints are the profile's touchpoints at or before `occurred_at`, within the lookback window (default 90 days). A conversion with no touchpoints gives `{ unattributed: 1 }`; it is never dropped.
- **Accept:** for every model and conversion, `|sum(credits) − 1| ≤ 1e-9` (fast-check property test); 100% branch coverage.

### M7 — Dashboard
- Pages:
  - Overview: funnel by stage.
  - Profile search → single customer timeline, with link evidence.
  - Attribution: model switcher, revenue by channel.
  - Data quality: null rates, stitch rate, freshness from `loaded_at`.
- Server components query Postgres directly via a thin data layer; no ORM.
- **Accept:** CI `build` passes; `perf-report` numbers recorded in `docs/results.md` (reported, not gated).

### M8 — Deploy
- **Cloud decided here.** Leaning toward GCP: Cloud Run for the dashboard, Cloud SQL for Postgres 16, seeding as a Cloud Run Job. The alternative is AWS ECS Fargate + RDS; Fargate needs an ALB that costs money even when idle. Record the choice in `docs/adr/0003-cloud.md`.
- Terraform in `infra/terraform`; CI `terraform` job.
- **Accept:**
  - Public URL in README.
  - `docs/architecture.md` with a Mermaid diagram.
  - **A budget alert** (Terraform-managed) at a stated monthly amount.
  - **A written teardown plan** (`docs/teardown.md`: `terraform destroy` steps, what survives it, e.g. state bucket and backups, and how to verify billing stopped).

## Definition of done
From a clean clone:
```bash
docker compose up -d && pnpm install && pnpm db:migrate && pnpm seed && pnpm dev
```
shows a working dashboard. `pnpm seed` also runs stitching, so it needs `uv` installed.
