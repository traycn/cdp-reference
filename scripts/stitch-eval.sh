#!/usr/bin/env bash
# Seed (generate, load, stitch; scripts/seed.sh) and evaluate each given seed,
# one after another, into .data/eval/eval-<seed>.json. Used by CI's stitch-eval
# and reproduce jobs, and locally:
#
#   scripts/stitch-eval.sh 42 7 1234
#   (cd services/stitch && uv run --locked cdp-stitch report --seed 42 --seed 7 --seed 1234 \
#      --out ../../docs/results.md --check)
#
# Needs the database migrated, Node 22+ with the workspace installed, and uv.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
[ "$#" -gt 0 ] || { echo "usage: $0 SEED..." >&2; exit 2; }

for seed in "$@"; do
  "$root/scripts/seed.sh" "$seed"
  (
    cd "$root/services/stitch"
    uv run --locked cdp-stitch evaluate --out "../../.data/eval/eval-$seed.json"
  )
done
