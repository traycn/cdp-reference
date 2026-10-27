#!/usr/bin/env bash
# Generate, load, stitch, materialize (lifecycle stages, history, conversions) and
# lead-score each given seed, one after another. `pnpm seed` runs it for seed 42;
# scripts/stitch-eval.sh runs it before evaluating.
#
#   scripts/seed.sh 42
#
# Needs the database migrated, Node 22+ with the workspace installed, and uv.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
[ "$#" -gt 0 ] || { echo "usage: $0 SEED..." >&2; exit 2; }
# Held-out seeds only with the acceptance-frozen tag (scripts/held-out.sh).
# shellcheck source=held-out.sh
source "$root/scripts/held-out.sh"
allow_held_out "$@"

for seed in "$@"; do
  echo "== seed $seed"
  (
    cd "$root/services/ingest"
    node generate.ts --seed "$seed" --out "../../.data/seed-$seed"
    node load.ts --dir "../../.data/seed-$seed"
  )
  (
    cd "$root/services/stitch"
    uv run --locked cdp-stitch run
  )
  (
    cd "$root/services/lifecycle"
    node cli.ts run --new-dataset
  )
  (
    cd "$root/services/lead-score"
    node cli.ts run
  )
done
