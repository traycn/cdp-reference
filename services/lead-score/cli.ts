/**
 * Lead scoring (M5; docs/plans/m5-lead-scoring.md).
 *
 *   node cli.ts run [--expect-no-change]   write core.lead_score (scripts/seed.sh runs it)
 *   node cli.ts training-rows --seed N     dev seed only: population, labels and snapshots
 *                                          at the training cutoffs → .data/lead-score/
 *   node cli.ts fit                        fit on the three dev seeds' training rows →
 *                                          packages/marketing-logic/src/score-weights.json
 *   node cli.ts evaluate --seed N [--check] the measure at 2026-01-01 →
 *                                          .data/eval/lead-score-N.json; with --check, exit 1
 *                                          if the form-fill bar is missed (the ceiling bar is
 *                                          reported, not failed; acceptance.md change log
 *                                          2026-10-26). CI judges the bars in cdp-stitch report.
 *
 * run, training-rows and evaluate need the seed loaded and stitched. scripts/fit-lead-score.sh
 * runs the whole fit.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assertDatabaseHolds } from "@cdp/ingest/ceiling";
import { generate, WINDOW_END } from "@cdp/ingest/generator";
import { DEFAULT_DATABASE_URL } from "@cdp/ingest/loader";
import { assertSeedAllowed, DEV_SEEDS } from "@cdp/ingest/seeds";
import pg from "pg";
import { readDataset } from "./src/dataset.ts";
import { evaluate, labelledSnapshots } from "./src/evaluate.ts";
import { fitWeights, TRAINING_CUTOFFS, type TrainingSet } from "./src/fit.ts";
import { writeScores } from "./src/write.ts";

const DATA = new URL("../../.data/", import.meta.url);
const WEIGHTS_FILE = new URL(
  "../../packages/marketing-logic/src/score-weights.json",
  import.meta.url,
);
const trainingFile = (seed: number): URL => new URL(`lead-score/training-${seed}.json`, DATA);

async function withClient<T>(f: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL,
  });
  await client.connect();
  try {
    return await f(client);
  } finally {
    await client.end();
  }
}

async function loadWeights(): Promise<
  (typeof import("@cdp/marketing-logic/weights"))["SCORE_WEIGHTS"]
> {
  return (await import("@cdp/marketing-logic/weights")).SCORE_WEIGHTS;
}

function seedOption(values: { seed?: string | undefined }): number {
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed is required");
  assertSeedAllowed(seed);
  return seed;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      seed: { type: "string" },
      "expect-no-change": { type: "boolean" },
      check: { type: "boolean" },
    },
  });
  const command = positionals[0];

  if (command === "run") {
    const weights = await loadWeights();
    const r = await withClient(async (c) => writeScores(c, await readDataset(c), weights));
    console.log(
      `lead score: ${r.profiles} profiles as of ${r.asOf}: ` +
        `+${r.inserted} ~${r.updated} -${r.deleted}`,
    );
    if (values["expect-no-change"] && r.inserted + r.updated + r.deleted > 0) {
      console.error("FAIL re-running the lead score changed rows");
      return 1;
    }
    return 0;
  }

  if (command === "training-rows") {
    const seed = seedOption(values);
    if (!DEV_SEEDS.includes(seed)) throw new Error(`seed ${seed} is not a development seed`);
    const tables = generate({ seed, people: 10_000, dobRate: 0.3 });
    const sets: TrainingSet[] = await withClient(async (c) => {
      await assertDatabaseHolds(c, tables, seed);
      const d = await readDataset(c);
      return TRAINING_CUTOFFS.map((cutoff) => ({
        seed,
        cutoff,
        rows: labelledSnapshots(tables, d, WINDOW_END, Date.parse(`${cutoff}T00:00:00Z`)).map(
          ({ row, snapshot }) => ({ profileId: row.profileId, label: row.label, snapshot }),
        ),
      }));
    });
    mkdirSync(new URL("lead-score/", DATA), { recursive: true });
    writeFileSync(trainingFile(seed), JSON.stringify(sets) + "\n");
    for (const s of sets)
      console.log(
        `seed ${seed} cutoff ${s.cutoff}: ${s.rows.length} profiles, ` +
          `${s.rows.filter((r) => r.label).length} positives`,
      );
    return 0;
  }

  if (command === "fit") {
    const sets = DEV_SEEDS.flatMap(
      (seed) => JSON.parse(readFileSync(trainingFile(seed), "utf8")) as TrainingSet[],
    );
    const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
    const { weights, ok } = fitWeights(sets, {
      commit: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]) !== "",
    });
    const f = weights.fit;
    for (const g of f.halfLifeGrid)
      console.log(
        `H ${String(g.halfLifeDays).padStart(2)} d: mean training AUC ${g.meanAuc.toFixed(4)}` +
          (g.zeroed.length ? `, zeroed ${g.zeroed.join(", ")}` : ""),
      );
    console.log(`chosen H ${weights.halfLifeDays} d; points ${JSON.stringify(weights.points)}`);
    for (const t of f.trainingAuc)
      console.log(
        `seed ${t.seed} ${t.cutoff}: linear ${t.linear.toFixed(4)}, rounded ${t.rounded.toFixed(4)}, ` +
          `cost ${t.cost.toFixed(4)}`,
      );
    if (!ok) {
      console.error(
        `FAIL rounding cost ${f.maxRoundingCost.toFixed(4)} ≥ 0.005; weights not written`,
      );
      return 1;
    }
    writeFileSync(WEIGHTS_FILE, JSON.stringify(weights, null, 2) + "\n");
    console.log(`wrote ${WEIGHTS_FILE.pathname}`);
    return 0;
  }

  if (command === "evaluate") {
    const seed = seedOption(values);
    const weights = await loadWeights();
    const tables = generate({ seed, people: 10_000, dobRate: 0.3 });
    const e = await withClient(async (c) => {
      await assertDatabaseHolds(c, tables, seed);
      return evaluate(seed, tables, await readDataset(c), weights, WINDOW_END);
    });
    mkdirSync(new URL("eval/", DATA), { recursive: true });
    writeFileSync(new URL(`eval/lead-score-${seed}.json`, DATA), JSON.stringify(e, null, 2) + "\n");
    const f = (x: number): string => x.toFixed(4);
    console.log(
      `lead score seed ${seed}: population ${e.population}, positives ${e.positives}\n` +
        `  AUC score ${f(e.auc.score)} · form fills ${f(e.auc.form_fills)} · ` +
        `random ${f(e.auc.random)} · cutoff-visible ceiling ${f(e.auc.ceiling_cutoff_visible)} · ` +
        `ceiling ${f(e.auc.ceiling)}\n` +
        `  ${e.bars.baseline.ok ? "ok  " : "FAIL"}  score ≥ form-fill + 0.05 = ${f(e.bars.baseline.bar)}\n` +
        `  ${e.bars.ceiling.ok ? "ok  " : "miss"}  score ≥ ceiling − 0.05 = ${f(e.bars.ceiling.bar)}` +
        " (reported, not failed)",
    );
    return values.check && !e.bars.baseline.ok ? 1 : 0;
  }

  console.error(
    "usage: node cli.ts run [--expect-no-change] | training-rows --seed N | fit | " +
      "evaluate --seed N [--check]",
  );
  return 2;
}

process.exitCode = await main();
