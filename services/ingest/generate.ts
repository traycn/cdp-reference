/**
 * Synthetic feeds for one seed.
 *
 *   node generate.ts --seed 42 --people 10000 --dob-rate 0.30 --out ../../.data/seed-42
 *
 * Writes one CSV per raw.* and eval.* table plus manifest.json (SHA-256 per
 * file and overall). Fails if a count is outside the docs/acceptance.md ranges.
 */
import { parseArgs } from "node:util";
import { GENERATE_ARGS, generateOptions, run } from "./src/cli.ts";
import { checkCounts, countTables, formatChecks } from "./src/counts.ts";
import { buildManifest, serialize, writeDataset } from "./src/dataset.ts";
import { generate } from "./src/generator.ts";
import { assertSeedAllowed } from "./src/seeds.ts";

run(() => {
  const { values: args } = parseArgs({ options: { ...GENERATE_ARGS, out: { type: "string" } } });
  const opts = generateOptions(args);
  assertSeedAllowed(opts.seed);
  const out = args.out ?? `../../.data/seed-${opts.seed}`;

  const started = performance.now();
  const tables = generate(opts);
  const files = serialize(tables);
  const manifest = buildManifest(opts, tables, files);
  writeDataset(out, files, manifest);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  for (const [file, entry] of Object.entries(manifest.files)) {
    console.log(`${entry.rows.toString().padStart(8)}  ${file}`);
  }
  console.log(`seed ${opts.seed}: sha256 ${manifest.sha256} → ${out} (${seconds} s)\n`);

  const checks = checkCounts(countTables(tables), opts.people, opts.dobRate);
  console.log(formatChecks(checks));
  if (checks.some((c) => !c.ok)) throw new Error("counts outside docs/acceptance.md ranges");
});
