#!/usr/bin/env bash
# Seed (generate, load, stitch, lifecycle, lead score; scripts/seed.sh) and evaluate
# each given seed, one after another, into .data/eval/eval-<seed>.json and
# .data/eval/lead-score-<seed>.json. Used by CI's stitch-eval
# and reproduce jobs, and locally:
#
#   scripts/stitch-eval.sh 42 7 1234 2026 99 31337
#   (cd services/stitch && uv run --locked cdp-stitch report --seed 42 --seed 7 --seed 1234 \
#      --seed 2026 --seed 99 --seed 31337 \
#      --out ../../docs/results.md --check)
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
  "$root/scripts/seed.sh" "$seed"
  (
    cd "$root/services/stitch"
    uv run --locked cdp-stitch evaluate --out "../../.data/eval/eval-$seed.json"
  )
  # The M5 measure (docs/acceptance.md, Lead scoring) → .data/eval/lead-score-<seed>.json.
  # Bars are judged by `cdp-stitch report --check`, like the identity bars, so a missed
  # bar never stops this script before the results page is written.
  (
    cd "$root/services/lead-score"
    node cli.ts evaluate --seed "$seed"
  )
done
