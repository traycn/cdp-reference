#!/usr/bin/env bash
# Fit the lead-score weights on the development seeds (docs/plans/m5-lead-scoring.md):
# for each dev seed, generate, load and stitch it and extract the training rows at the
# training cutoffs; then fit and write packages/marketing-logic/src/score-weights.json.
# The measure cutoff (2026-01-01) is not used. Held-out seeds are refused.
#
#   scripts/fit-lead-score.sh
#
# Needs the database migrated, Node 22+ with the workspace installed, and uv.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

for seed in 42 7 1234; do
  echo "== seed $seed"
  (
    cd "$root/services/ingest"
    node generate.ts --seed "$seed" --out "../../.data/seed-$seed" > /dev/null
    node load.ts --dir "../../.data/seed-$seed" > /dev/null
  )
  (
    cd "$root/services/stitch"
    uv run --locked cdp-stitch run > /dev/null
  )
  (
    cd "$root/services/lead-score"
    node cli.ts training-rows --seed "$seed"
  )
done
(
  cd "$root/services/lead-score"
  node cli.ts fit
)
