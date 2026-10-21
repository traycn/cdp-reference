import type { GenerateOptions } from "./generator.ts";

/** --seed, --people, --dob-rate with the docs/acceptance.md defaults. */
export function generateOptions(values: {
  seed?: string;
  people?: string;
  "dob-rate"?: string;
}): GenerateOptions {
  return {
    seed: Number(values.seed ?? 42),
    people: Number(values.people ?? 10_000),
    dobRate: Number(values["dob-rate"] ?? 0.3),
  };
}

export const GENERATE_ARGS = {
  seed: { type: "string" },
  people: { type: "string" },
  "dob-rate": { type: "string" },
} as const;

/** Runs main and turns a thrown error into a one-line message and exit code 1. */
export function run(main: () => Promise<void> | void): void {
  Promise.resolve()
    .then(main)
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
