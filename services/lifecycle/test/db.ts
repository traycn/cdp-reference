/** A throwaway database next to DATABASE_URL, migrated from db/migrations. */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS = join(fileURLToPath(import.meta.url), "../../../../db/migrations");
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://cdp:cdp_local_only@localhost:5432/cdp";

export interface TestDb {
  client: pg.Client;
  drop: () => Promise<void>;
}

/** Null when there is no Postgres and CI is not set; with CI set the error is thrown. */
export async function createTestDb(): Promise<TestDb | null> {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    if (process.env["CI"]) throw error;
    return null;
  }
  const name = `cdp_lifecycle_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await client.query(readFileSync(join(MIGRATIONS, file), "utf8").split("-- migrate:down")[0]!);
  }
  return {
    client,
    drop: async () => {
      await client.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
