/**
 * node cli.ts run [--new-dataset]   materialize once
 * node cli.ts verify                materialize again, check idempotence and the row rules,
 *                                   print the report; exit 1 on any violation
 *
 * Run `run --new-dataset` right after loading and stitching a dataset (scripts/seed.sh does).
 * `verify` expects that to have happened.
 */
import pg from "pg";
import { backwardMoves, checkRows, snapshot } from "./src/checks.ts";
import { materialize, type MaterializeResult } from "./src/materialize.ts";

const DEFAULT_DATABASE_URL = "postgres://cdp:cdp_local_only@localhost:5432/cdp";

function describe(r: MaterializeResult): string {
  const stages = Object.entries(r.stageCounts)
    .map(([s, n]) => `${s} ${n}`)
    .join(" · ");
  return [
    `profiles ${r.profiles}: ${stages}`,
    `conversions: mql ${r.mqlConversions}, won ${r.wonConversions}` +
      (r.wonWithoutClosedAt
        ? ` (${r.wonWithoutClosedAt} won opportunities have no closed_at)`
        : ""),
    `held backward attempts: ${r.held}`,
    `written: history ${r.changes.history}, stages ${r.changes.stages}, ` +
      `conversions ${r.changes.conversions} (+${r.changes.conversionsDeleted} deleted)`,
  ].join("\n  ");
}

async function main(): Promise<number> {
  const [command, ...flags] = process.argv.slice(2);
  if (command !== "run" && command !== "verify") {
    console.error("usage: node cli.ts run [--new-dataset] | verify");
    return 2;
  }
  const client = new pg.Client({
    connectionString: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL,
  });
  await client.connect();
  try {
    if (command === "run") {
      const result = await materialize(client, { newDataset: flags.includes("--new-dataset") });
      console.log(`lifecycle:\n  ${describe(result)}`);
      return 0;
    }
    const before = await snapshot(client);
    const result = await materialize(client);
    const after = await snapshot(client);
    const violations = await checkRows(client);
    const backward = await backwardMoves(client);
    const problems: string[] = [];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      problems.push(`re-running changed the data: ${JSON.stringify({ before, after })}`);
    }
    const wrote = Object.values(result.changes).reduce((a, b) => a + b, 0);
    if (wrote > 0)
      problems.push(`re-running wrote ${wrote} rows: ${JSON.stringify(result.changes)}`);
    if (result.held > 0)
      problems.push(`${result.held} profiles would move backward with no reason`);
    for (const v of violations)
      problems.push(`${v.rule}: ${v.count} (e.g. ${v.examples.join(", ")})`);

    console.log(`lifecycle:\n  ${describe(result)}`);
    console.log(`  backward moves in history: ${backward}`);
    console.log(`  conversion hash ${after.conversionHash}`);
    console.log(`  stage hash      ${after.stageHash}`);
    if (problems.length > 0) {
      for (const p of problems) console.error(`FAIL ${p}`);
      return 1;
    }
    console.log("ok    re-running changed nothing; won consistency and monotonic rules hold");
    return 0;
  } finally {
    await client.end();
  }
}

process.exitCode = await main();
