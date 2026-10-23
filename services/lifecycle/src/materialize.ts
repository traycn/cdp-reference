/**
 * Writes what the definitions say about each profile into core:
 *  - core.customer_profile.lifecycle_stage: the profile's current stage;
 *  - core.lifecycle_history: every stage it has had, forward only (migration 006);
 *  - core.conversion: `mql` at the first form submission, `won` per won opportunity.
 *
 * The rules live in packages/marketing-logic (definitions.ts); this file only reads the
 * facts, applies them and writes. Re-running on the same data changes nothing: rows are
 * upserted only when a column differs, and rows that no longer belong are deleted.
 *
 * A stage never goes down here. If the facts now say a lower stage than the profile has
 * (for example after a re-stitch moved an opportunity to another profile), the profile
 * keeps its stage and the attempt is counted as `held`. Only a new dataset
 * (`newDataset: true`, used right after a load) starts every profile again from the facts.
 */
import {
  advanceStage,
  lifecycleStage,
  mqlOccurredAt,
  opportunityStageReached,
  LIFECYCLE_STAGES,
  type LifecycleStage,
  type OpportunityFacts,
} from "@cdp/marketing-logic";
import type pg from "pg";

export interface MaterializeOptions {
  /** The raw data was just replaced by a different dataset: forget stages and history. */
  newDataset?: boolean;
}

export interface MaterializeResult {
  profiles: number;
  stageCounts: Record<LifecycleStage, number>;
  mqlConversions: number;
  wonConversions: number;
  /** Won opportunities with no closed_at: no conversion can be dated, so none is written. */
  wonWithoutClosedAt: number;
  /** Computed stage was lower than the profile's, with no reason to lower it: kept. */
  held: number;
  changes: { history: number; stages: number; conversions: number; conversionsDeleted: number };
}

interface OppRow extends OpportunityFacts {
  opp_id: string;
  closed_at: Date | null;
  amount: string | null;
}

interface ConversionRow {
  id: string;
  profileId: string;
  kind: "mql" | "won";
  occurredAt: Date;
  revenue: string;
  sourceId: string | null;
}

export async function materialize(
  client: pg.Client,
  { newDataset = false }: MaterializeOptions = {},
): Promise<MaterializeResult> {
  await client.query("BEGIN");
  try {
    const result = await run(client, newDataset);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function run(client: pg.Client, newDataset: boolean): Promise<MaterializeResult> {
  if (newDataset) {
    await client.query("DELETE FROM core.lifecycle_history");
    await client.query(
      "UPDATE core.customer_profile SET lifecycle_stage = 'lead', updated_at = now() " +
        "WHERE lifecycle_stage <> 'lead'",
    );
  }

  const profiles = await client.query<{ pid: string; stage: LifecycleStage }>(
    "SELECT profile_id::text AS pid, lifecycle_stage AS stage FROM core.customer_profile ORDER BY 1",
  );
  const last = new Map(
    (
      await client.query<{ pid: string; seq: number; stage: LifecycleStage }>(
        `SELECT DISTINCT ON (profile_id) profile_id::text AS pid, seq, stage
         FROM core.lifecycle_history ORDER BY profile_id, seq DESC`,
      )
    ).rows.map((r) => [r.pid, r]),
  );
  const forms = new Map(
    (
      await client.query<{ pid: string; times: string[] }>(
        `SELECT l.profile_id::text AS pid, json_agg(f.occurred_at ORDER BY f.occurred_at) AS times
         FROM core.identity_link l
         JOIN staging.form_submission f ON f.source_event_id = l.id_value
         WHERE l.id_type = 'form_submission' GROUP BY 1`,
      )
    ).rows.map((r) => [r.pid, r.times.map((t) => new Date(t))]),
  );
  const opps = new Map<string, OppRow[]>();
  for (const r of (
    await client.query<OppRow & { pid: string }>(
      `SELECT l.profile_id::text AS pid, o.opp_id, o.stage, o.won, o.closed_at, o.amount::text AS amount
       FROM core.identity_link l
       JOIN staging.crm_opportunity o ON o.opp_id = l.id_value
       WHERE l.id_type = 'opp_id' ORDER BY o.opp_id COLLATE "C"`,
    )
  ).rows) {
    const list = opps.get(r.pid) ?? [];
    list.push(r);
    opps.set(r.pid, list);
  }

  const stageCounts = Object.fromEntries(LIFECYCLE_STAGES.map((s) => [s, 0])) as Record<
    LifecycleStage,
    number
  >;
  const history: { pid: string; seq: number; stage: LifecycleStage }[] = [];
  const stageUpdates: { pid: string; stage: LifecycleStage }[] = [];
  const conversions: ConversionRow[] = [];
  let held = 0;
  let wonWithoutClosedAt = 0;

  for (const { pid, stage: current } of profiles.rows) {
    const formTimes = forms.get(pid) ?? [];
    const profileOpps = opps.get(pid) ?? [];
    const firstFormAt = mqlOccurredAt(formTimes);
    const computed = lifecycleStage({ firstFormAt, opportunities: profileOpps });

    let target: LifecycleStage;
    const previous = last.get(pid);
    if (previous === undefined) {
      history.push({ pid, seq: 1, stage: computed });
      target = computed;
    } else {
      const decision = advanceStage(previous.stage, computed);
      if (decision.kind === "forward")
        history.push({ pid, seq: previous.seq + 1, stage: computed });
      if (decision.kind === "held") held++;
      target = decision.stage;
    }
    if (target !== current) stageUpdates.push({ pid, stage: target });
    stageCounts[target]++;

    if (firstFormAt !== null) {
      conversions.push({
        id: `mql:${pid}`,
        profileId: pid,
        kind: "mql",
        occurredAt: firstFormAt,
        revenue: "0",
        sourceId: null,
      });
    }
    for (const o of profileOpps) {
      if (opportunityStageReached(o) !== "won") continue;
      if (o.closed_at === null) {
        wonWithoutClosedAt++;
        continue;
      }
      conversions.push({
        id: `won:${o.opp_id}`,
        profileId: pid,
        kind: "won",
        occurredAt: o.closed_at,
        revenue: o.amount ?? "0",
        sourceId: o.opp_id,
      });
    }
  }

  const historyInserted = await client.query(
    `INSERT INTO core.lifecycle_history (profile_id, seq, stage)
     SELECT * FROM unnest($1::uuid[], $2::int[], $3::text[])`,
    [history.map((h) => h.pid), history.map((h) => h.seq), history.map((h) => h.stage)],
  );
  const stagesUpdated = await client.query(
    `UPDATE core.customer_profile p SET lifecycle_stage = u.stage, updated_at = now()
     FROM unnest($1::uuid[], $2::text[]) AS u(pid, stage) WHERE p.profile_id = u.pid`,
    [stageUpdates.map((u) => u.pid), stageUpdates.map((u) => u.stage)],
  );
  // Stale rows first: a profile's mql conversion is unique per profile, so a row whose
  // profile changed must not collide with its replacement.
  const deleted = await client.query(
    "DELETE FROM core.conversion WHERE conversion_id <> ALL($1::text[])",
    [conversions.map((c) => c.id)],
  );
  const upserted = await client.query(
    `INSERT INTO core.conversion AS c (conversion_id, profile_id, kind, occurred_at, revenue, source_id)
     SELECT * FROM unnest($1::text[], $2::uuid[], $3::text[], $4::timestamptz[], $5::numeric[], $6::text[])
     ON CONFLICT (conversion_id) DO UPDATE SET
       profile_id = EXCLUDED.profile_id, kind = EXCLUDED.kind, occurred_at = EXCLUDED.occurred_at,
       revenue = EXCLUDED.revenue, source_id = EXCLUDED.source_id
     WHERE (c.profile_id, c.kind, c.occurred_at, c.revenue, c.source_id)
       IS DISTINCT FROM (EXCLUDED.profile_id, EXCLUDED.kind, EXCLUDED.occurred_at,
                         EXCLUDED.revenue, EXCLUDED.source_id)`,
    [
      conversions.map((c) => c.id),
      conversions.map((c) => c.profileId),
      conversions.map((c) => c.kind),
      conversions.map((c) => c.occurredAt),
      conversions.map((c) => c.revenue),
      conversions.map((c) => c.sourceId),
    ],
  );

  return {
    profiles: profiles.rows.length,
    stageCounts,
    mqlConversions: conversions.filter((c) => c.kind === "mql").length,
    wonConversions: conversions.filter((c) => c.kind === "won").length,
    wonWithoutClosedAt,
    held,
    changes: {
      history: historyInserted.rowCount ?? 0,
      stages: stagesUpdated.rowCount ?? 0,
      conversions: upserted.rowCount ?? 0,
      conversionsDeleted: deleted.rowCount ?? 0,
    },
  };
}
