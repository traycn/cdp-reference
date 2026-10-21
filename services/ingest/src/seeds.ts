/** Seeds from docs/acceptance.md. */
export const DEV_SEEDS: readonly number[] = [42, 7, 1234];
export const HELD_OUT_SEEDS: readonly number[] = [2026, 99, 31337];

/**
 * Held-out seeds stay unrun until the thresholds are frozen in the
 * `acceptance-frozen` tag. Running one then needs CDP_ALLOW_HELD_OUT=1.
 */
export function assertSeedAllowed(seed: number): void {
  if (HELD_OUT_SEEDS.includes(seed) && process.env.CDP_ALLOW_HELD_OUT !== "1") {
    throw new Error(
      `seed ${seed} is held out (docs/acceptance.md); set CDP_ALLOW_HELD_OUT=1 only after acceptance-frozen`,
    );
  }
}
