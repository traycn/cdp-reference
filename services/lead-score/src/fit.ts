/**
 * Fitting the score weights (docs/plans/m5-lead-scoring.md, Fitting).
 *
 *  - Development seeds only; training cutoffs 2025-07-01 and 2025-10-01, with the
 *    measure's population and 90-day label. The measure cutoff (2026-01-01) is
 *    never used here.
 *  - For each half-life H in the grid: non-negative, L2-penalized (λ = 1) logistic
 *    regression of the label on F1–F3, E1–E5, pooled over the six seed × cutoff
 *    sets. H is the one with the highest mean AUC over those sets (compared at
 *    4 decimals; on a tie the longer H).
 *  - Points: coefficients × a scale that maps the 99th percentile of the pooled
 *    linear score to 100, rounded to halves. The cost of rounding (AUC of the
 *    unrounded linear score minus AUC of the integer total) must stay < 0.005 on
 *    every training set, or the fit fails.
 */
import { auc } from "@cdp/ingest/ceiling";
import {
  FEATURES,
  scoreFeatures,
  scoreSnapshot,
  type Feature,
  type ScoreSnapshot,
  type ScoreWeights,
} from "@cdp/marketing-logic";
import { fitLogistic } from "./regression.ts";

export const TRAINING_CUTOFFS: readonly string[] = ["2025-07-01", "2025-10-01"];
export const HALF_LIFE_GRID: readonly number[] = [7, 14, 21, 30, 45, 60, 90];
export const LAMBDA = 1;
export const FORM_CAP = 3;
export const SCALE_QUANTILE = 0.99;
export const SCALE_TO = 100;
export const MAX_ROUNDING_COST = 0.005;

export interface TrainingRow {
  profileId: string;
  label: boolean;
  snapshot: ScoreSnapshot;
}

/** One seed's training rows, per training cutoff (written by `training-rows`). */
export interface TrainingSet {
  seed: number;
  cutoff: string;
  rows: TrainingRow[];
}

export interface WeightsFile extends ScoreWeights {
  fit: {
    seeds: number[];
    trainingCutoffs: string[];
    lambda: number;
    nonNegative: true;
    halfLifeGrid: { halfLifeDays: number; meanAuc: number; zeroed: Feature[] }[];
    intercept: number;
    coefficients: Record<Feature, number>;
    zeroed: Feature[];
    scale: { quantile: number; to: number; factor: number };
    trainingAuc: { seed: number; cutoff: string; linear: number; rounded: number; cost: number }[];
    maxRoundingCost: number;
    commit: string;
    workingTreeDirty: boolean;
  };
}

const vector = (f: Record<Feature, number>): number[] => FEATURES.map((k) => f[k]);
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

export function fitWeights(
  sets: readonly TrainingSet[],
  git: { commit: string; dirty: boolean },
): { weights: WeightsFile; ok: boolean } {
  const rows = sets.flatMap((s) => s.rows);
  const y = rows.map((r) => r.label);

  const candidates = HALF_LIFE_GRID.map((h) => {
    const X = rows.map((r) =>
      vector(scoreFeatures(r.snapshot, { halfLifeDays: h, formCap: FORM_CAP })),
    );
    const fit = fitLogistic(X, y, { lambda: LAMBDA, nonNegative: true });
    const linear = (r: TrainingRow): number =>
      vector(scoreFeatures(r.snapshot, { halfLifeDays: h, formCap: FORM_CAP })).reduce(
        (s, x, j) => s + x * fit.coef[j]!,
        0,
      );
    const aucs = sets.map((s) =>
      auc(
        s.rows.map(linear),
        s.rows.map((r) => r.label),
      ),
    );
    return { h, fit, X, meanAuc: aucs.reduce((a, b) => a + b, 0) / aucs.length };
  });
  const best = candidates.reduce((a, b) =>
    round4(b.meanAuc) > round4(a.meanAuc) || (round4(b.meanAuc) === round4(a.meanAuc) && b.h > a.h)
      ? b
      : a,
  );

  const linearAll = best.X.map((x) => x.reduce((s, v, j) => s + v * best.fit.coef[j]!, 0));
  const sortedLinear = [...linearAll].sort((a, b) => a - b);
  const q = sortedLinear[Math.floor(SCALE_QUANTILE * (sortedLinear.length - 1))]!;
  const factor = SCALE_TO / q;
  const pointsOf = Object.fromEntries(
    FEATURES.map((k, j) => [k, Math.round(best.fit.coef[j]! * factor * 2) / 2]),
  ) as Record<Feature, number>;
  const weights: ScoreWeights = { halfLifeDays: best.h, formCap: FORM_CAP, points: pointsOf };

  let offset = 0;
  const trainingAuc = sets.map((s) => {
    const lin = linearAll.slice(offset, offset + s.rows.length);
    offset += s.rows.length;
    const labels = s.rows.map((r) => r.label);
    const linear = auc(lin, labels);
    const rounded = auc(
      s.rows.map((r) => scoreSnapshot(r.snapshot, weights).total),
      labels,
    );
    return { seed: s.seed, cutoff: s.cutoff, linear, rounded, cost: linear - rounded };
  });
  const maxCost = Math.max(...trainingAuc.map((t) => t.cost));
  const featureList = (idx: number[]): Feature[] => idx.map((j) => FEATURES[j]!);

  return {
    ok: maxCost < MAX_ROUNDING_COST,
    weights: {
      ...weights,
      fit: {
        seeds: [...new Set(sets.map((s) => s.seed))],
        trainingCutoffs: [...new Set(sets.map((s) => s.cutoff))],
        lambda: LAMBDA,
        nonNegative: true,
        halfLifeGrid: candidates.map((c) => ({
          halfLifeDays: c.h,
          meanAuc: c.meanAuc,
          zeroed: featureList(c.fit.zeroed),
        })),
        intercept: best.fit.intercept,
        coefficients: Object.fromEntries(FEATURES.map((k, j) => [k, best.fit.coef[j]!])) as Record<
          Feature,
          number
        >,
        zeroed: featureList(best.fit.zeroed),
        scale: { quantile: SCALE_QUANTILE, to: SCALE_TO, factor },
        trainingAuc,
        maxRoundingCost: maxCost,
        commit: git.commit,
        workingTreeDirty: git.dirty,
      },
    },
  };
}
