/**
 * Loads a generated dataset into raw.* and eval.* (idempotent; see src/loader.ts).
 *
 *   node load.ts --dir ../../.data/seed-42
 *
 * DATABASE_URL defaults to the docker-compose database.
 */
import { parseArgs } from "node:util";
import { run } from "./src/cli.ts";
import { formatChecks } from "./src/counts.ts";
import { DEFAULT_DATABASE_URL, loadDataset, type LoadResult } from "./src/loader.ts";

export function formatLoad(result: LoadResult): string {
  const lines = [`batch ${result.batchId}`];
  for (const t of result.tables) {
    lines.push(
      `${t.table.padEnd(22)} ${String(t.rows).padStart(8)} rows  ` +
        `+${t.inserted} ~${t.updated} -${t.deleted}`,
    );
  }
  return `${lines.join("\n")}\n\n${formatChecks(result.checks)}`;
}

run(async () => {
  const { values } = parseArgs({ options: { dir: { type: "string" } } });
  if (!values.dir) throw new Error("--dir is required");
  const result = await loadDataset(values.dir, process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  console.log(formatLoad(result));
  if (!result.ok) throw new Error("counts outside docs/acceptance.md ranges; load rolled back");
});
