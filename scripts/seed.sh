#!/usr/bin/env bash
# Generate, load and stitch each given seed, one after another. `pnpm seed`
# runs it for seed 42; scripts/stitch-eval.sh runs it before evaluating.
#
#   scripts/seed.sh 42
#
# Needs the database migrated, Node 22+ with the workspace installed, and uv.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
[ "$#" -gt 0 ] || { echo "usage: $0 SEED..." >&2; exit 2; }

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
done
