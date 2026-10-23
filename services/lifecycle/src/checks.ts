/**
 * Acceptance checks on database rows (docs/acceptance.md, Definitions and models):
 * lifecycle monotonic, won consistency, and an idempotence snapshot.
 */
import { createHash } from "node:crypto";
import type pg from "pg";

export interface Snapshot {
  counts: { profiles: number; conversions: number; history: number };
  /** SHA-256 of the sorted conversions: id, profile, kind, time (UTC), revenue, source. */
  conversionHash: string;
  /** SHA-256 of each profile's current stage and its history (no recorded_at). */
  stageHash: string;
}

async function hashRows(client: pg.Client, sql: string): Promise<string> {
  const { rows } = await client.query<{ line: string }>(sql);
  const digest = createHash("sha256");
  for (const { line } of rows) digest.update(`${line}\n`);
  return digest.digest("hex");
}

export async function snapshot(client: pg.Client): Promise<Snapshot> {
  const { rows } = await client.query<{ profiles: string; conversions: string; history: string }>(
    `SELECT (SELECT count(*) FROM core.customer_profile) AS profiles,
            (SELECT count(*) FROM core.conversion) AS conversions,
            (SELECT count(*) FROM core.lifecycle_history) AS history`,
  );
  const r = rows[0]!;
  return {
    counts: {
      profiles: Number(r.profiles),
      conversions: Number(r.conversions),
      history: Number(r.history),
    },
    conversionHash: await hashRows(
      client,
      `SELECT concat_ws(E'\\t', conversion_id, profile_id::text, kind,
                to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
                revenue::text, coalesce(source_id, '')) AS line
       FROM core.conversion ORDER BY conversion_id COLLATE "C"`,
    ),
    stageHash: await hashRows(
      client,
      `SELECT p.profile_id::text || E'\\t' || p.lifecycle_stage || E'\\t' ||
              coalesce((SELECT string_agg(h.seq || '=' || h.stage || '/' || coalesce(h.reason, ''), ','
                        ORDER BY h.seq) FROM core.lifecycle_history h
                        WHERE h.profile_id = p.profile_id), '') AS line
       FROM core.customer_profile p ORDER BY p.profile_id::text COLLATE "C"`,
    ),
  };
}

export interface Violation {
  rule: string;
  count: number;
  examples: string[];
}

const RULES: { rule: string; sql: string }[] = [
  {
    rule: "every Won profile has an opportunity with won = true",
    sql: `SELECT p.profile_id::text AS id FROM core.customer_profile p
          WHERE p.lifecycle_stage = 'won' AND NOT EXISTS (
            SELECT 1 FROM core.identity_link l
            JOIN staging.crm_opportunity o ON o.opp_id = l.id_value
            WHERE l.profile_id = p.profile_id AND l.id_type = 'opp_id' AND o.won)`,
  },
  {
    rule: "every won conversion belongs to a Won profile and a won opportunity",
    sql: `SELECT c.conversion_id AS id FROM core.conversion c
          JOIN core.customer_profile p USING (profile_id)
          WHERE c.kind = 'won' AND (p.lifecycle_stage <> 'won' OR NOT EXISTS (
            SELECT 1 FROM staging.crm_opportunity o WHERE o.opp_id = c.source_id AND o.won))`,
  },
  {
    rule: "every profile with a won opportunity has its won conversion",
    sql: `SELECT l.id_value AS id FROM core.identity_link l
          JOIN staging.crm_opportunity o ON o.opp_id = l.id_value
          WHERE l.id_type = 'opp_id' AND o.won AND o.stage = 'closed_won' AND o.closed_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM core.conversion c
                            WHERE c.kind = 'won' AND c.source_id = o.opp_id AND c.profile_id = l.profile_id)`,
  },
  {
    rule: "every mql conversion's profile is MQL or later",
    sql: `SELECT c.conversion_id AS id FROM core.conversion c
          JOIN core.customer_profile p USING (profile_id)
          WHERE c.kind = 'mql' AND p.lifecycle_stage = 'lead'`,
  },
  {
    rule: "every profile has history, and its last entry is its current stage",
    sql: `SELECT p.profile_id::text AS id FROM core.customer_profile p
          WHERE p.lifecycle_stage IS DISTINCT FROM (
            SELECT h.stage FROM core.lifecycle_history h WHERE h.profile_id = p.profile_id
            ORDER BY h.seq DESC LIMIT 1)`,
  },
  {
    rule: "no stage moves backward without a recorded reason",
    sql: `SELECT profile_id::text || '#' || seq AS id FROM (
            SELECT profile_id, seq, stage, reason,
                   lag(stage) OVER (PARTITION BY profile_id ORDER BY seq) AS prev
            FROM core.lifecycle_history) h
          WHERE prev IS NOT NULL
            AND array_position(ARRAY['lead','mql','sql','opportunity','won'], stage)
              < array_position(ARRAY['lead','mql','sql','opportunity','won'], prev)
            AND (reason IS NULL OR btrim(reason) = '')`,
  },
];

export async function checkRows(client: pg.Client): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const { rule, sql } of RULES) {
    const { rows } = await client.query<{ id: string }>(sql);
    if (rows.length > 0) {
      violations.push({ rule, count: rows.length, examples: rows.slice(0, 3).map((r) => r.id) });
    }
  }
  return violations;
}

/** History rows that go backward, with their reason; allowed, and listed in the report. */
export async function backwardMoves(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT stage, lag(stage) OVER (PARTITION BY profile_id ORDER BY seq) AS prev
       FROM core.lifecycle_history) h
     WHERE prev IS NOT NULL
       AND array_position(ARRAY['lead','mql','sql','opportunity','won'], stage)
         < array_position(ARRAY['lead','mql','sql','opportunity','won'], prev)`,
  );
  return Number(rows[0]!.n);
}
