/**
 * Writes core.lead_score for every profile, scored as of the latest event in the
 * dataset (docs/plans/m5-lead-scoring.md). scored_at is that time, not now(), so
 * re-running on the same data changes nothing: rows are updated only when a value
 * differs, and rows of profiles that no longer exist are deleted.
 */
import { scoreSnapshot, type ScoreWeights } from "@cdp/marketing-logic";
import type pg from "pg";
import type { Dataset } from "./dataset.ts";
import { buildSnapshots } from "./snapshot.ts";

export interface WriteResult {
  asOf: string;
  profiles: number;
  inserted: number;
  updated: number;
  deleted: number;
}

/** The latest web event or ad click; scores are taken as of this time. */
export function latestEvent(d: Dataset): number {
  let latest = -Infinity;
  for (const e of d.webEvents) if (e.at > latest) latest = e.at;
  for (const c of d.adClicks) if (c.at > latest) latest = c.at;
  if (latest === -Infinity) throw new Error("the dataset has no events");
  return latest;
}

export async function writeScores(
  client: pg.Client,
  d: Dataset,
  weights: ScoreWeights,
): Promise<WriteResult> {
  const asOf = latestEvent(d);
  const snaps = buildSnapshots(d, asOf);
  const ids: string[] = [];
  const fit: number[] = [];
  const engagement: number[] = [];
  for (const [id, s] of snaps) {
    const score = scoreSnapshot(s, weights);
    ids.push(id);
    fit.push(score.fit);
    engagement.push(score.engagement);
  }
  const at = new Date(asOf);
  await client.query("BEGIN");
  try {
    const upsert = await client.query<{ inserted: boolean }>(
      `INSERT INTO core.lead_score AS t (profile_id, fit_score, engagement_score, scored_at)
       SELECT p, f, e, $4 FROM unnest($1::uuid[], $2::int[], $3::int[]) AS u (p, f, e)
       ON CONFLICT (profile_id) DO UPDATE
         SET fit_score = EXCLUDED.fit_score,
             engagement_score = EXCLUDED.engagement_score,
             scored_at = EXCLUDED.scored_at
         WHERE (t.fit_score, t.engagement_score, t.scored_at)
               IS DISTINCT FROM (EXCLUDED.fit_score, EXCLUDED.engagement_score, EXCLUDED.scored_at)
       RETURNING (xmax = 0) AS inserted`,
      [ids, fit, engagement, at],
    );
    const deleted = await client.query(
      "DELETE FROM core.lead_score WHERE NOT (profile_id = ANY ($1::uuid[]))",
      [ids],
    );
    await client.query("COMMIT");
    const inserted = upsert.rows.filter((r) => r.inserted).length;
    return {
      asOf: at.toISOString(),
      profiles: ids.length,
      inserted,
      updated: upsert.rows.length - inserted,
      deleted: deleted.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
