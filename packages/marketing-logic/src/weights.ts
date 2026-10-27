/**
 * The fitted, frozen score weights (score-weights.json, written by
 * `services/lead-score` `node cli.ts fit`). Kept out of index.ts so that the fit
 * can run before the file exists.
 */
import json from "./score-weights.json" with { type: "json" };
import { parseScoreWeights, type ScoreWeights } from "./scoring.ts";

export const SCORE_WEIGHTS: ScoreWeights = parseScoreWeights(json);
