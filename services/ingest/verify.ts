/**
 * M2 acceptance for one or more seeds (docs/acceptance.md, Data and pipeline):
 *
 *  1. Determinism: generating the seed twice gives byte-identical files, and
 *     the overall SHA-256 matches seed-hashes.json.
 *  2. Counts: inside the docs/acceptance.md ranges (generator and database).
 *  3. Idempotent load: a second load inserts, updates and deletes nothing, and
 *     leaves every row count and max(loaded_at) unchanged.
 *
 *   node verify.ts --seed 42 --seed 7 --seed 1234 [--no-db] [--update-hashes]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { GENERATE_ARGS, generateOptions, run } from "./src/cli.ts";
import { checkCounts, countTables, formatChecks } from "./src/counts.ts";
import { buildManifest, serialize, writeDataset } from "./src/dataset.ts";
import { generate, type GenerateOptions } from "./src/generator.ts";
import { DEFAULT_DATABASE_URL, loadDataset, snapshotTables } from "./src/loader.ts";
import { assertSeedAllowed } from "./src/seeds.ts";

const HASHES_FILE = new URL("./seed-hashes.json", import.meta.url);

type HashKey = `${number}/${number}/${number}`;
const hashKey = (o: GenerateOptions): HashKey => `${o.seed}/${o.people}/${o.dobRate}`;

function readHashes(): Record<string, string> {
  return JSON.parse(readFileSync(HASHES_FILE, "utf8")) as Record<string, string>;
}

async function verifySeed(
  opts: GenerateOptions,
  db: string | null,
  update: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  const fail = (msg: string): void => {
    failures.push(`seed ${opts.seed}: ${msg}`);
    console.log(`FAIL  ${msg}`);
  };
  console.log(`\n== seed ${opts.seed} (${opts.people} people, dob-rate ${opts.dobRate}) ==`);

  // 1. Determinism: two independent runs, compared file by file.
  const runs = [0, 1].map(() => {
    const tables = generate(opts);
    const files = serialize(tables);
    return { tables, files, manifest: buildManifest(opts, tables, files) };
  });
  const [a, b] = runs as [(typeof runs)[0], (typeof runs)[0]];
  for (const [file, content] of a.files) {
    if (b.files.get(file) !== content) fail(`${file} differs between two runs of the same seed`);
  }
  console.log(`sha256 ${a.manifest.sha256} (run 1)`);
  console.log(`sha256 ${b.manifest.sha256} (run 2)`);
  if (a.manifest.sha256 !== b.manifest.sha256) fail("overall sha256 differs between runs");

  const hashes = readHashes();
  const key = hashKey(opts);
  if (update) {
    hashes[key] = a.manifest.sha256;
    writeFileSync(HASHES_FILE, JSON.stringify(hashes, null, 2) + "\n");
    console.log(`seed-hashes.json[${key}] updated`);
  } else if (hashes[key] === undefined) {
    fail(`no committed hash for ${key} in seed-hashes.json (run with --update-hashes)`);
  } else if (hashes[key] !== a.manifest.sha256) {
    fail(`sha256 differs from seed-hashes.json[${key}] = ${hashes[key]}`);
  } else {
    console.log(`ok    matches seed-hashes.json`);
  }

  // 2. Counts on the generator output.
  const checks = checkCounts(countTables(a.tables), opts.people, opts.dobRate);
  console.log(formatChecks(checks));
  for (const c of checks) if (!c.ok) fail(`${c.name} = ${c.value}, expected ${c.expected}`);
  if (db === null) return failures;

  // 3. Load twice; the second load must be a no-op.
  const dir = `../../.data/seed-${opts.seed}`;
  writeDataset(dir, a.files, a.manifest);
  const first = await loadDataset(dir, db);
  if (!first.ok) fail("database counts outside ranges on first load (rolled back)");
  const before = await snapshotTables(db);
  const second = await loadDataset(dir, db);
  const after = await snapshotTables(db);
  for (const t of second.tables) {
    if (t.inserted + t.updated + t.deleted > 0) {
      fail(`second load changed ${t.table}: +${t.inserted} ~${t.updated} -${t.deleted}`);
    }
  }
  for (const [table, snap] of Object.entries(before)) {
    const now = after[table]!;
    const line = `${table.padEnd(22)} ${String(snap.rows).padStart(8)} → ${String(now.rows).padStart(8)} rows`;
    if (snap.rows !== now.rows || snap.maxLoadedAt !== now.maxLoadedAt) {
      fail(`${line}; max(loaded_at) ${snap.maxLoadedAt} → ${now.maxLoadedAt}`);
    } else {
      console.log(`ok    ${line}, max(loaded_at) unchanged`);
    }
  }
  return failures;
}

run(async () => {
  const { values } = parseArgs({
    options: {
      ...GENERATE_ARGS,
      seed: { type: "string", multiple: true },
      "no-db": { type: "boolean" },
      "update-hashes": { type: "boolean" },
    },
  });
  const seeds = values.seed ?? ["42"];
  const db = values["no-db"] ? null : (process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const failures: string[] = [];
  for (const seed of seeds) {
    const opts = generateOptions({ ...values, seed });
    assertSeedAllowed(opts.seed);
    failures.push(...(await verifySeed(opts, db, values["update-hashes"] ?? false)));
  }
  console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.join("\n")}`);
  if (failures.length > 0) throw new Error(`${failures.length} check(s) failed`);
});
