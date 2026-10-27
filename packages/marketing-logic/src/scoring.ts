/**
 * Lead scoring (M5): fit and engagement rules with decay, as planned in
 * docs/plans/m5-lead-scoring.md and measured as in docs/acceptance.md (Lead scoring).
 *
 * Pure. A profile's snapshot as of a time `asOf` goes in; fit points and
 * engagement points come out. What a snapshot may contain (only what existed
 * before `asOf`) is the snapshot reader's job (services/lead-score); the rules
 * here also ignore anything at or after `asOf`, so a leak would have to get
 * past both.
 *
 * Weights and the half-life are configuration (score-weights.json, fitted on the
 * development seeds); nothing in the rules is tuned.
 */

export const DAY_MS = 86_400_000;

/** Page paths that count as high intent (E3). */
export const INTENT_PAGES: readonly string[] = ["/pricing", "/demo"];

/** Stand-ins for gmail, outlook and the like in the synthetic data (F2). */
export const PERSONAL_EMAIL_DOMAINS: readonly string[] = [
  "example.com",
  "example.net",
  "example.org",
];

/** What the rules may see of a profile as of `asOf` (epoch ms). Event lists hold times. */
export interface ScoreSnapshot {
  asOf: number;
  /** The most recently updated CRM contact visible at `asOf`, or null. */
  contact: { title: string | null; email: string | null; emailVerified: boolean | null } | null;
  /** Form fills linked to the profile. */
  formFills: readonly number[];
  /** First page view of each visible session. */
  sessionStarts: readonly number[];
  /** Visible page views of INTENT_PAGES. */
  intentPageViews: readonly number[];
  /** Visible ad clicks. */
  adClicks: readonly number[];
  /** Latest visible event of any kind, or null. */
  lastEventAt: number | null;
}

export const FIT_FEATURES = ["seniority", "businessEmail", "verifiedEmail"] as const;
export const ENGAGEMENT_FEATURES = [
  "formFills",
  "sessions",
  "intentPages",
  "adClicks",
  "recency",
] as const;
export const FEATURES = [...FIT_FEATURES, ...ENGAGEMENT_FEATURES] as const;
export type Feature = (typeof FEATURES)[number];
export type ScoreFeatures = Record<Feature, number>;

export interface ScoreWeights {
  /** Half-life H of the decay, in days. */
  halfLifeDays: number;
  /** E1 counts decayed form fills up to this many. */
  formCap: number;
  /** Points per unit of each feature. */
  points: Record<Feature, number>;
}

export interface Score {
  fit: number;
  engagement: number;
  total: number;
}

/** F1: 3 executive, 2 director, 1 manager, 0 anything else; checked in that order. */
export function seniority(title: string | null | undefined): number {
  if (!title) return 0;
  if (/\b(founder|chief|ceo|cto|cfo|coo|cmo|vp|vice president)\b/i.test(title)) return 3;
  if (/\b(director|head of)\b/i.test(title)) return 2;
  if (/\b(manager|lead)\b/i.test(title)) return 1;
  return 0;
}

/** F2: an email whose domain is not a personal-mail domain. */
export function isBusinessEmail(email: string | null | undefined): boolean {
  const e = email?.trim().toLowerCase() ?? "";
  const at = e.lastIndexOf("@");
  if (at < 0) return false;
  const domain = e.slice(at + 1);
  return domain !== "" && !PERSONAL_EMAIL_DOMAINS.includes(domain);
}

/** d(Δ) = 2^(−Δ / H), Δ in days before asOf. */
export function decay(deltaDays: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) throw new Error("half-life must be positive");
  return 2 ** (-deltaDays / halfLifeDays);
}

/** Sum of decay weights over the times strictly before asOf. */
function decayedCount(times: readonly number[], asOf: number, halfLifeDays: number): number {
  let sum = 0;
  for (const t of times) if (t < asOf) sum += decay((asOf - t) / DAY_MS, halfLifeDays);
  return sum;
}

/** Feature values of the rules F1–F3 and E1–E5. */
export function scoreFeatures(
  s: ScoreSnapshot,
  { halfLifeDays, formCap }: Pick<ScoreWeights, "halfLifeDays" | "formCap">,
): ScoreFeatures {
  const d = (times: readonly number[]): number => decayedCount(times, s.asOf, halfLifeDays);
  const recency =
    s.lastEventAt !== null && s.lastEventAt < s.asOf
      ? decay((s.asOf - s.lastEventAt) / DAY_MS, halfLifeDays)
      : 0;
  return {
    seniority: seniority(s.contact?.title),
    businessEmail: isBusinessEmail(s.contact?.email) ? 1 : 0,
    verifiedEmail: s.contact?.emailVerified === true ? 1 : 0,
    formFills: Math.min(d(s.formFills), formCap),
    sessions: Math.log1p(d(s.sessionStarts)),
    intentPages: d(s.intentPageViews),
    adClicks: d(s.adClicks),
    recency,
  };
}

/** Unrounded points of a feature vector, split into fit and engagement. */
export function points(f: ScoreFeatures, w: ScoreWeights): { fit: number; engagement: number } {
  let fit = 0;
  let engagement = 0;
  for (const k of FIT_FEATURES) fit += w.points[k] * f[k];
  for (const k of ENGAGEMENT_FEATURES) engagement += w.points[k] * f[k];
  return { fit, engagement };
}

/** Integer scores as stored in core.lead_score; total = fit + engagement. */
export function scoreSnapshot(s: ScoreSnapshot, w: ScoreWeights): Score {
  const p = points(scoreFeatures(s, w), w);
  const fit = Math.round(p.fit);
  const engagement = Math.round(p.engagement);
  return { fit, engagement, total: fit + engagement };
}

/** Checks a parsed score-weights.json and returns its ScoreWeights part. */
export function parseScoreWeights(json: unknown): ScoreWeights {
  const o = json as Partial<ScoreWeights> | null;
  if (typeof o?.halfLifeDays !== "number" || !(o.halfLifeDays > 0))
    throw new Error("score weights: halfLifeDays must be a positive number");
  if (typeof o.formCap !== "number" || !(o.formCap > 0))
    throw new Error("score weights: formCap must be a positive number");
  const pts: Partial<Record<Feature, number>> = o.points ?? {};
  for (const k of FEATURES) {
    const v = pts[k];
    if (typeof v !== "number" || !(v >= 0))
      throw new Error(`score weights: points.${k} must be ≥ 0`);
  }
  return {
    halfLifeDays: o.halfLifeDays,
    formCap: o.formCap,
    points: Object.fromEntries(FEATURES.map((k) => [k, pts[k]!])) as Record<Feature, number>,
  };
}
