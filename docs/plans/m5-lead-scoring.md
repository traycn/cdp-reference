# M5 plan: lead scoring

Status: plan, 2026-10-23. No scoring code exists yet. The measure, bars and ceilings are fixed in [`acceptance.md`](../acceptance.md#lead-scoring-m5) and are not changed by anything here.

## What gets built

| Piece | Where | Does |
|---|---|---|
| Rules and decay | `packages/marketing-logic/src/scoring.ts` | Pure functions: a profile snapshot as of a time → fit points, engagement points. Weights and half-life come from a config object, never from constants inside the rules |
| Weights | `packages/marketing-logic/src/score-weights.json` | The fitted, frozen weights and half-life. Changed only by the fit script, and frozen by the `acceptance-frozen` tag |
| Snapshot reader | `services/lead-score` (new, like `services/lifecycle`) | Reads a profile's CRM contacts and attached events from `core` and `staging`, applying the visibility rules below for a given `asOf` |
| Writer | `services/lead-score`, `node cli.ts run` | Writes `core.lead_score` for every profile with `asOf` = the latest event in the dataset. It sets `scored_at = asOf` instead of `now()`, so re-runs are idempotent. Runs in `scripts/seed.sh` after lifecycle |
| Fit | `services/lead-score`, `node cli.ts fit` | Development seeds only (refuses any other seed). Fits the weights at the training cutoffs (below) and writes `score-weights.json` |
| Evaluate | `services/lead-score`, `node cli.ts evaluate` | At the measure cutoff: score AUC, form-fill AUC, random AUC, and the ceiling (from `services/ingest/src/ceiling.ts`). Fails if a bar is missed. Added to CI's `stitch-eval` job and to `docs/results.md` |

## Visibility as of a time (the leakage guard)

The snapshot for `asOf = T` contains only:

- **CRM contacts** in the profile with `updated_at ≤ T`. Fit rules read the most recently updated of them.
- **Form fills** in the profile with `occurred_at < T`.
- **Web events and ad clicks** with `occurred_at < T`, if they reach the profile through a form fill before `T`. That means either:
  - their session holds a form fill before `T` that is linked to the profile; or
  - their device has at least one form fill before `T`, and all of its form fills before `T` are in the profile.

  This is stricter than device rule (d). Rule (d) uses every form fill, including later ones, so a link made only by later evidence would reveal pre-cutoff activity.
- **Nothing else:** no opportunities, no lifecycle stage, no conversions, nothing from `eval`.

**Leakage test** (`services/lead-score/test/leakage.test.ts`): build a fixture dataset and score every profile at `T`. Then score again after each of these changes, and require bit-identical scores every time:
1. delete every row dated after `T`;
2. shift those rows by ±30 days, staying after `T`;
3. add new rows after `T`: events, form fills on existing devices, contacts, opportunities.

A second test makes sure a pre-`T` change does move a score, so the leakage test can't pass just because the score never changes.

## Fit rules

From the CRM contact visible at `T`. Each rule gives points; the weights are fit (below).

| # | Rule | Input |
|---|---|---|
| F1 | **Seniority** from title keywords, checked in this order: executive (`Founder`, `Chief`, `CEO`/`CTO`/`CFO`/`COO`/`CMO`, `VP`, `Vice President`) → 3; director (`Director`, `Head of`) → 2; manager (`Manager`, `Lead`) → 1; anything else → 0 | `title` |
| F2 | Business email: the domain is not a personal-mail domain (`example.com`, `example.net`, `example.org` stand in for gmail/outlook/etc.) | `email` |
| F3 | Verified email | `email_verified` |

These are ordinary B2B rules; they are not read off the generator. The generator's true model uses a fixed seniority table and ignores email domain and verification. So:
- F2 and F3 should fit to about zero. If they do, the fit can tell a real rule from a dead one.
- F1's keyword rule maps `Office Manager` to 1, where the generator says 0. This is left as is: matching the generator's private table would be fitting to the answer key.

## Engagement rules

Each event before `T` counts with a decay weight `d(Δ) = 2^(−Δ / H)`, where `Δ` is days before `T` and `H` is the half-life.

| # | Rule | Points |
|---|---|---|
| E1 | Form fills | `w_form · min(Σ d(Δ_i), cap_form)` over form fills |
| E2 | Sessions | `w_session · ln(1 + Σ d(Δ_i))` over session starts (first page view of a visible session) |
| E3 | High-intent pages | `w_intent · Σ d(Δ_i)` over page views of `/pricing` and `/demo` |
| E4 | Ad clicks | `w_click · Σ d(Δ_i)` over visible ad clicks |
| E5 | Recency | `w_recency · 2^(−Δ_last / H)`, where `Δ_last` is days since the last visible event; 0 if none |

`fit_score = round(Σ fit points)` and `engagement_score = round(Σ engagement points)`, as `INT` per `core.lead_score`. The weights are scaled so that `total_score` spans about 0–100. The AUC is computed on `total_score`, so rounding creates ties, and ties count half. The scale is chosen so that rounding costs less than 0.005 AUC on the training cutoffs. The fit script reports this cost by comparing the rounded and unrounded scores.

E3 and E4, like F2 and F3, aren't in the true model. They are kept as candidates the fit may zero out.

## Fitting

- **Data:** development seeds 42, 7, 1234 only. `fit` refuses any other seed.
- **Training cutoffs:** 2025-07-01 and 2025-10-01, with the same population and 90-day label rules as the measure. The measure's cutoff, 2026-01-01, is **not** used for fitting. The dev-seed AUCs reported at that cutoff are therefore not fitted to it. The held-out seeds remain the real test.
- **Method:**
  1. For each `H` in {7, 14, 21, 30, 45, 60, 90} days, fit a logistic regression (no ML library; IRLS or gradient descent in TS, with a small L2 penalty `λ = 1`, fixed) of the label on F1–F3 and E1–E5. Rows: dev-seed profiles at both training cutoffs, pooled.
  2. Pick the `H` with the highest mean AUC over the six seed × cutoff sets. On a tie, take the longer `H`.
  3. Scale the coefficients to points, and round to whole points or halves.
  4. Negative coefficients are set to 0 and refit, since a rule can only add points.
- **Output:** `score-weights.json` with the weights, `H`, `cap_form`, the training AUCs and the git commit of the fit.
- **Then:** run `evaluate` on the dev seeds at the measure cutoff. That gives the score, form-fill and random AUCs against the bars. Results go into `docs/results.md`.
- **If a dev seed misses a bar:** say so and stop. Any rule or method change after seeing measure-cutoff numbers needs a dated `acceptance.md` change-log entry with the numbers seen. The bars themselves don't move.
- **Freeze:** tag `acceptance-frozen` with the weights, then run the held-out seeds 2026, 99, 31337 once, report them against the same bars, and mark them "held out".

## Tests (marketing-logic ≥ 90% line coverage)

- One test per fit rule, including keyword order (a title with both `VP` and `Manager` → 3) and an empty or missing title.
- One test per engagement rule.
- Decay: `d(0) = 1`, `d(H) = 0.5`, `d(2H) = 0.25`, and decay is monotone in `Δ`. An event at exactly `T` is excluded; one at `T − 1 ms` is included.
- The cap on form fills.
- Rounding gives integer scores, and the total equals fit plus engagement.
- The leakage tests above.
- AUC is reused from `services/ingest/src/ceiling.ts`, which already has tests.

## Open points for M5 part 2

- The visibility rule for devices (all pre-`T` form fills in the profile) is stricter than rule (d). If the fit shows that this costs a lot of engagement, the alternative is rule (d) recomputed from pre-`T` form fills only. Choosing it would need a change-log entry before any measure-cutoff AUC is seen.
- `core.lead_score` has one row per profile and no `asOf`, so evaluation-time scores are not stored. If the dashboard should show score history, that needs a new table, which is M7's call.
