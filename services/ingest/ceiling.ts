/**
 * The M5 ceiling for one seed (docs/acceptance.md, change log 2026-10-23): the
 * AUC of the generator's true probabilities on the lead-score population.
 * Needs the seed generated, loaded and stitched (scripts/seed.sh); profiles
 * come from core.identity_link.
 *
 *   node ceiling.ts --seed 42
 *
 * Prints the population, positives, mean true probability and the ceiling AUC.
 * Computes no lead score.
 */
import { parseArgs } from "node:util";
import pg from "pg";
import { assertDatabaseHolds, auc, CUTOFF, HORIZON, population } from "./src/ceiling.ts";
import { GENERATE_ARGS, generateOptions, run } from "./src/cli.ts";
import { generate, WINDOW_END } from "./src/generator.ts";
import { DEFAULT_DATABASE_URL } from "./src/loader.ts";
import { assertSeedAllowed } from "./src/seeds.ts";

run(async () => {
  const { values } = parseArgs({ options: GENERATE_ARGS });
  const opts = generateOptions(values);
  assertSeedAllowed(opts.seed);
  const tables = generate(opts);

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
  await client.connect();
  let profileOfContact: Map<string, string>;
  try {
    await assertDatabaseHolds(client, tables, opts.seed);

    const links = await client.query<{ id_value: string; profile_id: string }>(
      `SELECT id_value, profile_id::text FROM core.identity_link WHERE id_type = 'crm_id'`,
    );
    profileOfContact = new Map(links.rows.map((r) => [r.id_value, r.profile_id]));
  } finally {
    await client.end();
  }

  const rows = population(tables, profileOfContact, WINDOW_END);
  const positives = rows.filter((r) => r.label).length;
  const meanTrue = rows.reduce((s, r) => s + r.trueProbability, 0) / rows.length;
  const ceiling = auc(
    rows.map((r) => r.trueProbability),
    rows.map((r) => r.label),
  );
  console.log(
    `seed ${opts.seed}: cutoff ${new Date(CUTOFF).toISOString().slice(0, 10)}, ` +
      `horizon ${HORIZON / 86_400_000} days`,
  );
  console.log(`population ${rows.length} profiles, positives ${positives}`);
  console.log(
    `positive rate ${(positives / rows.length).toFixed(4)}, ` +
      `mean true probability ${meanTrue.toFixed(4)}`,
  );
  console.log(`ceiling AUC ${ceiling.toFixed(4)}`);
});
