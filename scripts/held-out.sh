# Sourced by scripts/seed.sh and scripts/stitch-eval.sh. If any of the given seeds is
# held out (docs/acceptance.md, Seeds), allow it only when the acceptance-frozen tag
# exists, by exporting CDP_ALLOW_HELD_OUT=1 for the generator and the lead-score
# evaluation. Without the tag, held-out seeds are refused. The lead-score fit
# (scripts/fit-lead-score.sh) never sources this: it stays on the development seeds.
#
#   allow_held_out SEED...

HELD_OUT_SEEDS="2026 99 31337"

allow_held_out() {
  local seed held
  for seed in "$@"; do
    for held in $HELD_OUT_SEEDS; do
      [ "$seed" = "$held" ] || continue
      if ! git -C "$root" rev-parse -q --verify "refs/tags/acceptance-frozen" > /dev/null; then
        echo "seed $seed is held out and there is no acceptance-frozen tag; refusing" >&2
        exit 2
      fi
      export CDP_ALLOW_HELD_OUT=1
    done
  done
}
