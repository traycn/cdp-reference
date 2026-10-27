/**
 * The M5 measure for one seed (docs/acceptance.md, Lead scoring): AUC at the
 * cutoff 2026-01-01 of an opportunity opening within 90 days, among profiles with
 * a CRM contact and no opportunity yet. Score, form-fill baseline, random baseline
 * and the ceiling, against the two bars.
 */
import { auc, CUTOFF, HORIZON, population, type PopulationRow } from "@cdp/ingest/ceiling";
import { Rng } from "@cdp/ingest/rng";
import { scoreSnapshot, type ScoreSnapshot, type ScoreWeights } from "@cdp/marketing-logic";
import type { Tables } from "@cdp/ingest/tables";
import { profileOfContact, type Dataset } from "./dataset.ts";
import { buildSnapshots } from "./snapshot.ts";

/** Rng stream of the random baseline ("rand"). */
export const RANDOM_STREAM = 0x72616e64;
export const BASELINE_MARGIN = 0.05;
export const CEILING_MARGIN = 0.05;

/** The population with each profile's snapshot at `cutoff`. */
export function labelledSnapshots(
  tables: Tables,
  d: Dataset,
  windowEnd: number,
  cutoff: number,
): { row: PopulationRow; snapshot: ScoreSnapshot }[] {
  const rows = population(tables, profileOfContact(d), windowEnd, cutoff, HORIZON);
  const snaps = buildSnapshots(
    d,
    cutoff,
    rows.map((r) => r.profileId),
  );
  return rows.map((row) => ({ row, snapshot: snaps.get(row.profileId)! }));
}

export interface Evaluation {
  seed: number;
  cutoff: string;
  horizon_days: number;
  population: number;
  positives: number;
  weights: ScoreWeights;
  auc: {
    score: number;
    form_fills: number;
    random: number;
    /** Diagnostic, report only (change log 2026-10-26): inputs frozen at the cutoff. */
    ceiling_cutoff_visible: number;
    ceiling: number;
  };
  /**
   * `enforced` bars fail CI (cdp-stitch report --check). The ceiling bar stays as
   * written but is reported, not failed: the ceiling includes engagement after the
   * cutoff (docs/acceptance.md, change log 2026-10-26).
   */
  bars: {
    baseline: { bar: number; ok: boolean; enforced: true };
    ceiling: { bar: number; ok: boolean; enforced: false };
  };
}

export function evaluate(
  seed: number,
  tables: Tables,
  d: Dataset,
  weights: ScoreWeights,
  windowEnd: number,
  cutoff = CUTOFF,
): Evaluation {
  const rows = labelledSnapshots(tables, d, windowEnd, cutoff); // sorted by profile_id
  const labels = rows.map((r) => r.row.label);
  const rng = new Rng(seed, RANDOM_STREAM);
  const a = {
    score: auc(
      rows.map((r) => scoreSnapshot(r.snapshot, weights).total),
      labels,
    ),
    form_fills: auc(
      rows.map((r) => r.snapshot.formFills.length),
      labels,
    ),
    random: auc(
      rows.map(() => rng.float()),
      labels,
    ),
    ceiling_cutoff_visible: auc(
      rows.map((r) => r.row.cutoffVisibleProbability),
      labels,
    ),
    ceiling: auc(
      rows.map((r) => r.row.trueProbability),
      labels,
    ),
  };
  const baselineBar = a.form_fills + BASELINE_MARGIN;
  const ceilingBar = a.ceiling - CEILING_MARGIN;
  return {
    seed,
    cutoff: new Date(cutoff).toISOString(),
    horizon_days: HORIZON / 86_400_000,
    population: rows.length,
    positives: labels.filter(Boolean).length,
    weights: {
      halfLifeDays: weights.halfLifeDays,
      formCap: weights.formCap,
      points: weights.points,
    },
    auc: a,
    bars: {
      baseline: { bar: baselineBar, ok: a.score >= baselineBar, enforced: true },
      ceiling: { bar: ceilingBar, ok: a.score >= ceilingBar, enforced: false },
    },
  };
}
