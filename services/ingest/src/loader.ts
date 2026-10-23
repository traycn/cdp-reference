/**
 * Loads a generated dataset into raw.* and eval.* in one transaction.
 *
 * Each file is a full snapshot of its table, so after a load the table holds
 * exactly the file's rows:
 *  - new keys are inserted;
 *  - existing keys are updated only if a column changed (loaded_at and
 *    batch_id move only then);
 *  - keys missing from the file are deleted.
 * Loading the same dataset twice therefore changes nothing. The count checks
 * run inside the transaction; if one fails, the load rolls back.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import {
  checkCounts,
  type Check,
  type Counts,
  HAZARD_KINDS,
  IDENTITY_HAZARD_KINDS,
  PERSON_KINDS,
} from "./counts.ts";
import { readManifest } from "./dataset.ts";
import { TABLE_SPECS } from "./tables.ts";

export const DEFAULT_DATABASE_URL = "postgres://cdp:cdp_local_only@localhost:5432/cdp";

export interface TableResult {
  table: string;
  rows: number;
  inserted: number;
  updated: number;
  deleted: number;
}

export interface LoadResult {
  batchId: string;
  tables: TableResult[];
  checks: Check[];
  ok: boolean;
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function loadDataset(dir: string, databaseUrl: string): Promise<LoadResult> {
  const manifest = readManifest(dir);
  const batchId = `seed${manifest.seed}-${manifest.sha256.slice(0, 12)}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const tables: TableResult[] = [];
    for (const spec of TABLE_SPECS) {
      tables.push(await loadTable(client, spec, join(dir, spec.file), batchId));
    }
    const checks = checkCounts(await countDatabase(client), manifest.people, manifest.dob_rate);
    const ok = checks.every((c) => c.ok);
    await client.query(ok ? "COMMIT" : "ROLLBACK");
    return { batchId, tables, checks, ok };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

async function loadTable(
  client: pg.Client,
  spec: {
    table: string;
    columns: readonly string[];
    primaryKey: readonly string[];
    loadMetadata: boolean;
  },
  file: string,
  batchId: string,
): Promise<TableResult> {
  const cols = spec.columns.map(ident);
  const keys = spec.primaryKey.map(ident);
  const nonKey = spec.columns.filter((c) => !spec.primaryKey.includes(c)).map(ident);

  await client.query(
    `CREATE TEMP TABLE incoming ON COMMIT DROP AS SELECT ${cols.join(", ")} FROM ${spec.table} WITH NO DATA`,
  );
  await pipeline(
    createReadStream(file),
    client.query(
      copyFrom(`COPY incoming (${cols.join(", ")}) FROM STDIN WITH (FORMAT csv, HEADER true)`),
    ),
  );

  const target = spec.loadMetadata ? [...cols, "batch_id"] : cols;
  const source = spec.loadMetadata ? [...cols, "$1"] : cols;
  const sets = nonKey.map((c) => `${c} = EXCLUDED.${c}`);
  if (spec.loadMetadata) sets.push("batch_id = EXCLUDED.batch_id", "loaded_at = now()");
  const changed = `(${nonKey.map((c) => `t.${c}`).join(", ")}) IS DISTINCT FROM (${nonKey
    .map((c) => `EXCLUDED.${c}`)
    .join(", ")})`;
  // xmax = 0 only on a freshly inserted row.
  const upsert = await client.query<{ inserted: boolean }>(
    `INSERT INTO ${spec.table} AS t (${target.join(", ")})
     SELECT ${source.join(", ")} FROM incoming
     ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ${sets.join(", ")} WHERE ${changed}
     RETURNING (xmax = 0) AS inserted`,
    spec.loadMetadata ? [batchId] : [],
  );
  const deleted = await client.query(
    `DELETE FROM ${spec.table} t WHERE NOT EXISTS (
       SELECT 1 FROM incoming i WHERE ${keys.map((k) => `i.${k} = t.${k}`).join(" AND ")})`,
  );
  const rows = await client.query<{ n: string }>(`SELECT count(*) AS n FROM incoming`);
  await client.query("DROP TABLE incoming");

  const inserted = upsert.rows.filter((r) => r.inserted).length;
  return {
    table: spec.table,
    rows: Number(rows.rows[0]!.n),
    inserted,
    updated: upsert.rows.length - inserted,
    deleted: deleted.rowCount ?? 0,
  };
}

/** The same Counts as countTables, read from the database. */
export async function countDatabase(client: pg.Client): Promise<Counts> {
  const one = async (sql: string): Promise<number> =>
    Number((await client.query<{ n: string }>(sql)).rows[0]!.n);

  const kinds = Object.fromEntries(PERSON_KINDS.map((k) => [k, 0])) as Counts["kinds"];
  const kindRows = await client.query<{ person_kind: keyof Counts["kinds"]; n: string }>(
    `SELECT person_kind, count(DISTINCT person_id) AS n FROM eval.truth_record GROUP BY 1`,
  );
  for (const r of kindRows.rows) kinds[r.person_kind] = Number(r.n);

  const hazardPairs = Object.fromEntries(HAZARD_KINDS.map((k) => [k, 0])) as Counts["hazard_pairs"];
  const groups = Object.fromEntries(
    IDENTITY_HAZARD_KINDS.map((k) => [k, { both: 0, one: 0, none: 0 }]),
  ) as Counts["hazard_dob_groups"];
  const hazardRows = await client.query<{ kind: keyof Counts["hazard_pairs"]; n_dob: number }>(
    `WITH person_dob AS (
       SELECT r.person_id, bool_or(c.dob IS NOT NULL) AS has_dob
       FROM eval.truth_record r JOIN raw.crm_contact c ON c.crm_id = r.unit_key
       WHERE r.unit_type = 'crm_contact' GROUP BY r.person_id)
     SELECT h.kind, (coalesce(a.has_dob, false)::int + coalesce(b.has_dob, false)::int) AS n_dob
     FROM eval.truth_hazard_pair h
     LEFT JOIN person_dob a ON a.person_id = h.person_a
     LEFT JOIN person_dob b ON b.person_id = h.person_b`,
  );
  for (const r of hazardRows.rows) {
    hazardPairs[r.kind]++;
    if (r.kind === "shared_device") continue;
    groups[r.kind][r.n_dob === 2 ? "both" : r.n_dob === 1 ? "one" : "none"]++;
  }

  const units = (type: string): Promise<number> =>
    one(`SELECT count(*) AS n FROM eval.truth_record WHERE unit_type = '${type}'`);
  return {
    crm_contact: await one(`SELECT count(*) AS n FROM raw.crm_contact`),
    crm_opportunity: await one(`SELECT count(*) AS n FROM raw.crm_opportunity`),
    web_event: await one(`SELECT count(*) AS n FROM raw.web_event`),
    ad_click: await one(`SELECT count(*) AS n FROM raw.ad_click`),
    tracked_events: await one(
      `SELECT (SELECT count(*) FROM raw.web_event)
            + (SELECT count(*) FROM raw.ad_click WHERE anonymous_id IS NOT NULL) AS n`,
    ),
    form_submission: await one(
      `SELECT count(*) AS n FROM raw.web_event WHERE event_name = 'form_submit'`,
    ),
    event_devices: await one(
      `SELECT count(*) AS n FROM (SELECT anonymous_id FROM raw.web_event
       UNION SELECT anonymous_id FROM raw.ad_click WHERE anonymous_id IS NOT NULL) d`,
    ),
    contacts_with_dob: await one(`SELECT count(*) AS n FROM raw.crm_contact WHERE dob IS NOT NULL`),
    truth_crm_contact: await units("crm_contact"),
    truth_form_submission: await units("form_submission"),
    truth_device: await units("device"),
    truth_event: await one(`SELECT count(*) AS n FROM eval.truth_event`),
    shared_devices: await one(
      `SELECT count(*) AS n FROM (
         SELECT d.anonymous_id FROM eval.truth_event t
         JOIN (SELECT 'web_event' AS source_table, source_event_id, anonymous_id FROM raw.web_event
               UNION ALL
               SELECT 'ad_click', source_event_id, anonymous_id FROM raw.ad_click
               WHERE anonymous_id IS NOT NULL) d
           USING (source_table, source_event_id)
         GROUP BY d.anonymous_id HAVING count(DISTINCT t.person_id) > 1) s`,
    ),
    persons: await one(`SELECT count(DISTINCT person_id) AS n FROM eval.truth_record`),
    kinds,
    hazard_pairs: hazardPairs,
    hazard_dob_groups: groups,
  };
}

/** Row count and max(loaded_at) per raw table, plus row counts for eval tables. */
export async function snapshotTables(
  databaseUrl: string,
): Promise<Record<string, { rows: number; maxLoadedAt: string | null }>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const out: Record<string, { rows: number; maxLoadedAt: string | null }> = {};
    for (const spec of TABLE_SPECS) {
      const maxLoaded = spec.loadMetadata ? "max(loaded_at)::text" : "NULL::text";
      const r = await client.query<{ n: string; max_loaded_at: string | null }>(
        `SELECT count(*) AS n, ${maxLoaded} AS max_loaded_at FROM ${spec.table}`,
      );
      out[spec.table] = { rows: Number(r.rows[0]!.n), maxLoadedAt: r.rows[0]!.max_loaded_at };
    }
    return out;
  } finally {
    await client.end();
  }
}
