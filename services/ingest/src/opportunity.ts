/**
 * Opportunity model, GENERATOR_VERSION 3 (docs/acceptance.md, "Opportunity model").
 *
 * Each CRM person gets a weekly chance of a first opportunity, from the week
 * their CRM contact is created. The chance is a logistic function of title
 * seniority and of the person's own engagement before the week starts: form
 * fills, sessions, and how recently they were last active. Stage, amount and a
 * possible second opportunity are drawn as in version 2.
 *
 * Pure and shared: the generator draws opportunities with it, and the M5
 * ceiling (ceiling.ts) computes each person's true probability with it from the
 * generator's output files alone.
 */
import type { Rng } from "./rng.ts";

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
const WEEK_SECONDS = WEEK / 1000;

/** Rng stream for opportunities; the main stream (0) draws everything else. */
export const OPPORTUNITY_STREAM = 0x6f707031;

/** Title → seniority: 0 individual contributor, 1 manager or lead, 2 director or head, 3 executive. */
export const SENIORITY: Readonly<Record<string, number>> = {
  "Data Analyst": 0,
  "Software Engineer": 0,
  "Office Manager": 0,
  Consultant: 0,
  "Marketing Manager": 1,
  "Demand Gen Lead": 1,
  "Product Manager": 1,
  "IT Manager": 1,
  "Head of Growth": 2,
  "Operations Director": 2,
  "Sales Director": 2,
  "VP Marketing": 3,
  CTO: 3,
  CFO: 3,
  Founder: 3,
};

/** True coefficients of the weekly logistic hazard. The intercept sets the overall rate near 25%. */
export const COEF = {
  intercept: -7.3,
  seniority: 0.45,
  forms: 0.6,
  logSessions: 0.35,
  recency: 2.5,
} as const;

/** Recency decays as exp(−days / RECENCY_TAU_DAYS). */
export const RECENCY_TAU_DAYS = 21;
/** Form fills count up to this many. */
export const FORM_CAP = 3;

export const OPP_STAGE = {
  closed_won: 0.3,
  closed_lost: 0.35,
  prospecting: 0.1,
  qualification: 0.1,
  proposal: 0.08,
  negotiation: 0.07,
} as const;
export const P_SECOND_OPPORTUNITY = 0.15;

export interface OpportunityPerson {
  /** When the CRM contact that owns the person's opportunities was created (its updated_at). */
  created: number;
  title: string;
  /** Start (first page view) of every session the person produced, on any device; ascending. */
  sessionStarts: readonly number[];
  /** Every form fill the person made; ascending. */
  formTimes: readonly number[];
}

export interface Features {
  seniority: number;
  forms: number;
  sessions: number;
  /** Days since the last session start or form fill; null if there was none. */
  recencyDays: number | null;
}

/** Number of values in an ascending list strictly before `at`. */
function countBefore(sorted: readonly number[], at: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Features at time `at`, from activity strictly before it. */
export function featuresAt(p: OpportunityPerson, at: number): Features {
  const sessions = countBefore(p.sessionStarts, at);
  const forms = countBefore(p.formTimes, at);
  const last = Math.max(
    sessions > 0 ? p.sessionStarts[sessions - 1]! : -Infinity,
    forms > 0 ? p.formTimes[forms - 1]! : -Infinity,
  );
  const seniority = SENIORITY[p.title];
  if (seniority === undefined) throw new Error(`no seniority for title ${p.title}`);
  return {
    seniority,
    forms,
    sessions,
    recencyDays: last === -Infinity ? null : (at - last) / DAY,
  };
}

/** Probability that the first opportunity opens in a week that starts with these features. */
export function weeklyHazard(f: Features): number {
  const recency = f.recencyDays === null ? 0 : Math.exp(-f.recencyDays / RECENCY_TAU_DAYS);
  const z =
    COEF.intercept +
    COEF.seniority * f.seniority +
    COEF.forms * Math.min(f.forms, FORM_CAP) +
    COEF.logSessions * Math.log1p(f.sessions) +
    COEF.recency * recency;
  return 1 / (1 + Math.exp(-z));
}

/** The last day an opportunity can open, as in version 2. */
export const latestOpen = (windowEnd: number): number => windowEnd - 2 * DAY;

/** Start of each week a first opportunity can open in: created + k weeks, ending by latestOpen. */
export function weekStarts(created: number, windowEnd: number): number[] {
  const out: number[] = [];
  for (let s = created; s + WEEK <= latestOpen(windowEnd); s += WEEK) out.push(s);
  return out;
}

/**
 * P(first opportunity opened at or before t). Within its week the opening
 * time is uniform over whole seconds, as drawn in drawOpportunities.
 */
export function firstOpenCdf(p: OpportunityPerson, windowEnd: number, t: number): number {
  let survive = 1;
  let cdf = 0;
  for (const s of weekStarts(p.created, windowEnd)) {
    if (s > t) break;
    const h = weeklyHazard(featuresAt(p, s));
    const inWeek = Math.min(Math.floor((t - s) / 1000) + 1, WEEK_SECONDS) / WEEK_SECONDS;
    cdf += survive * h * inWeek;
    survive *= 1 - h;
  }
  return cdf;
}

export interface OpportunityDraw {
  stage: string;
  amount: string;
  opened: number;
  closed: number | null;
  won: boolean | null;
}

/** Draws a person's opportunities (none, one or two) from the opportunity stream. */
export function drawOpportunities(
  rng: Rng,
  p: OpportunityPerson,
  windowEnd: number,
): OpportunityDraw[] {
  let first: number | null = null;
  for (const s of weekStarts(p.created, windowEnd)) {
    if (rng.bool(weeklyHazard(featuresAt(p, s)))) {
      first = s + rng.int(0, WEEK_SECONDS - 1) * 1000;
      break;
    }
  }
  if (first === null) return [];
  const out = [opportunityAt(rng, first, windowEnd)];
  if (rng.bool(P_SECOND_OPPORTUNITY)) {
    const opened = Math.min(
      first + rng.int(1, 60) * DAY + rng.int(0, 86_399) * 1000,
      latestOpen(windowEnd),
    );
    out.push(opportunityAt(rng, opened, windowEnd));
  }
  return out;
}

/** Stage, amount and close date, drawn as in version 2. */
function opportunityAt(rng: Rng, opened: number, windowEnd: number): OpportunityDraw {
  let stage: string = rng.weighted(OPP_STAGE);
  const closed = opened + rng.int(7, 120) * DAY;
  const isClosed = stage.startsWith("closed_") && closed < windowEnd;
  if (stage.startsWith("closed_") && !isClosed) {
    stage = rng.pick(["prospecting", "qualification", "proposal", "negotiation"]);
  }
  return {
    stage,
    amount: `${rng.int(20, 1200) * 100}.00`,
    opened,
    closed: isClosed ? closed : null,
    won: isClosed ? stage === "closed_won" : null,
  };
}
