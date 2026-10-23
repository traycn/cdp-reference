/**
 * The marketing definitions: lifecycle stages, UTM/referrer → channel, conversion kinds.
 * docs/definitions.md explains each one in plain language.
 *
 * The channel rules are written twice, here and in staging.channel_for / staging.web_event
 * (db/migrations/005_channel_site_host.sql). test/channel-parity.test.ts runs one table of
 * cases through both and fails on any difference. Change both together.
 */
import type { Channel } from "@cdp/attribution";

// ---------------------------------------------------------------------------
// Conversion kinds (core.conversion.kind)
// ---------------------------------------------------------------------------

/**
 * `won`: one row per won opportunity; occurred_at = closed_at, revenue = amount.
 * `mql`: one row per profile reaching MQL; occurred_at = when the criterion was first met,
 *        revenue = 0.
 */
export const CONVERSION_KINDS = ["won", "mql"] as const;
export type ConversionKind = (typeof CONVERSION_KINDS)[number];

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Our own site. A referrer on this host (or a subdomain) is never a referral source (ADR 0002). */
export const SITE_HOST = "northbeam-cdp.example";

const MEDIUM_CHANNELS: Record<string, Channel> = {
  cpc: "paid_search",
  ppc: "paid_search",
  paid_search: "paid_search",
  sem: "paid_search",
  paid_social: "paid_social",
  paidsocial: "paid_social",
  social_paid: "paid_social",
  cpm: "paid_social",
  email: "email",
  "e-mail": "email",
  newsletter: "email",
  organic: "organic",
  social: "organic",
  organic_social: "organic",
  referral: "referral",
};

const SEARCH_ENGINES = ["google", "bing", "duckduckgo", "yahoo", "ecosia"];

const INTERNAL_REFERRER = new RegExp(
  `^(https?://)?([a-z0-9-]+\\.)*${SITE_HOST.replaceAll(".", "\\.")}([:/?#]|$)`,
);
const SEARCH_REFERRER = new RegExp(`^(https?://)?([a-z0-9-]+\\.)*(${SEARCH_ENGINES.join("|")})\\.`);

/** Platform of an ad click with no UTM tags: still paid, so fall back to the platform. */
const PLATFORM_CHANNELS: Record<string, Channel> = {
  google_ads: "paid_search",
  meta: "paid_social",
  linkedin: "paid_social",
};

/** Postgres btrim(x) trims spaces only, so this does too (not tabs or newlines). */
function btrim(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

/** NULLIF(btrim(x), '') */
function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = btrim(value);
  return trimmed === "" ? null : trimmed;
}

function normalize(value: string | null | undefined): string | null {
  return blankToNull(value)?.toLowerCase() ?? null;
}

export function isInternalReferrer(referrer: string | null | undefined): boolean {
  const r = normalize(referrer);
  return r !== null && INTERNAL_REFERRER.test(r);
}

export interface ChannelInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  referrer?: string | null;
}

/**
 * The channel of one event, from its own fields only. Rules, in order:
 *  1. A recognized utm_medium decides the channel.
 *  2. UTM tags present but not recognized → `unattributed`.
 *  3. No tags and no referrer → `direct`.
 *  4. No tags and a referrer on our own site → `direct` (ADR 0002).
 *  5. No tags and a search-engine referrer → `organic`.
 *  6. No tags and any other referrer → `referral`.
 */
export function channelFor({ utmSource, utmMedium, referrer }: ChannelInput): Channel {
  const source = normalize(utmSource);
  const medium = normalize(utmMedium);
  if (medium !== null && Object.hasOwn(MEDIUM_CHANNELS, medium)) return MEDIUM_CHANNELS[medium]!;
  if (medium !== null || source !== null) return "unattributed";
  const ref = normalize(referrer);
  if (ref === null || INTERNAL_REFERRER.test(ref)) return "direct";
  if (SEARCH_REFERRER.test(ref)) return "organic";
  return "referral";
}

export interface AdClickInput {
  platform: string;
  utmSource?: string | null;
  utmMedium?: string | null;
}

/** An untagged click falls back to its platform; a tagged one is judged by its tags alone. */
export function adClickChannel({ platform, utmSource, utmMedium }: AdClickInput): Channel {
  if (blankToNull(utmSource) === null && blankToNull(utmMedium) === null) {
    return Object.hasOwn(PLATFORM_CHANNELS, platform)
      ? PLATFORM_CHANNELS[platform]!
      : "unattributed";
  }
  return channelFor({ utmSource, utmMedium });
}

export interface SessionEvent extends ChannelInput {
  id: string;
  occurredAt: Date;
  /** Events without a session keep their own channel. */
  sessionId?: string | null;
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Channel of every event once ADR 0002's session rule is applied: all events of a session get
 * the channel of the session's entry event (the earliest, ties broken by id in byte order).
 * Returns a map from event id to channel.
 */
export function sessionChannels(events: readonly SessionEvent[]): Map<string, Channel> {
  const entryByIdSession = new Map<string, SessionEvent>();
  for (const e of events) {
    if (e.sessionId == null) continue;
    const entry = entryByIdSession.get(e.sessionId);
    if (
      entry === undefined ||
      e.occurredAt < entry.occurredAt ||
      (e.occurredAt.getTime() === entry.occurredAt.getTime() && compareBytes(e.id, entry.id) < 0)
    ) {
      entryByIdSession.set(e.sessionId, e);
    }
  }
  const channels = new Map<string, Channel>();
  for (const e of events) {
    const entry = e.sessionId == null ? e : entryByIdSession.get(e.sessionId)!;
    channels.set(e.id, channelFor(entry));
  }
  return channels;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** In order. A stage's rank is its index. */
export const LIFECYCLE_STAGES = ["lead", "mql", "sql", "opportunity", "won"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export function stageRank(stage: LifecycleStage): number {
  return LIFECYCLE_STAGES.indexOf(stage);
}

/** The stage names in raw.crm_opportunity (lowercased and trimmed, as staging does). */
export const OPPORTUNITY_STAGES = [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export interface OpportunityFacts {
  stage: string;
  /** staging.crm_opportunity.won (NULL in raw counts as false). */
  won: boolean;
}

export interface LifecycleFacts {
  /** Time of the profile's earliest form submission, or null when it has none. */
  firstFormAt: Date | null;
  opportunities: readonly OpportunityFacts[];
}

/**
 * The lifecycle stage one opportunity proves, or null when it proves none.
 *  - prospecting: nothing (an early conversation is not a qualified one).
 *  - qualification: `sql`.
 *  - proposal, negotiation: `opportunity`.
 *  - closed_won with won = true: `won`. Marked closed_won without won = true: `opportunity`.
 *  - closed_lost: nothing. The CRM keeps only the final stage, so how far the deal got is
 *    unknown and a loss is not evidence of any stage.
 *  - Any other stage name: nothing.
 */
export function opportunityStageReached(opp: OpportunityFacts): LifecycleStage | null {
  switch (normalize(opp.stage)) {
    case "qualification":
      return "sql";
    case "proposal":
    case "negotiation":
      return "opportunity";
    case "closed_won":
      return opp.won ? "won" : "opportunity";
    default:
      return null;
  }
}

/**
 * The highest stage whose criterion is met. Stages are not entered in sequence: a CRM-only
 * contact with a qualified opportunity is `sql` without ever having been an `mql`.
 *  - lead: every profile.
 *  - mql: at least one form submission (the MQL criterion).
 *  - sql, opportunity, won: from the profile's opportunities, see opportunityStageReached.
 */
export function lifecycleStage(facts: LifecycleFacts): LifecycleStage {
  let best: LifecycleStage = facts.firstFormAt === null ? "lead" : "mql";
  for (const opp of facts.opportunities) {
    const reached = opportunityStageReached(opp);
    if (reached !== null && stageRank(reached) > stageRank(best)) best = reached;
  }
  return best;
}

/** When the MQL criterion was first met: the earliest form submission, or null. */
export function mqlOccurredAt(formSubmittedAt: readonly Date[]): Date | null {
  let first: Date | null = null;
  for (const at of formSubmittedAt) {
    if (first === null || at < first) first = at;
  }
  return first;
}

export type StageDecision =
  | { kind: "unchanged" | "forward"; stage: LifecycleStage }
  | { kind: "backward"; stage: LifecycleStage; reason: string }
  | { kind: "held"; stage: LifecycleStage; wanted: LifecycleStage };

/**
 * Stages only move forward. A computed stage below the current one is refused (`held`, the
 * current stage stays) unless a non-blank reason is given; then the move is applied and
 * returned as `backward` with its reason, ready to be recorded.
 */
export function advanceStage(
  current: LifecycleStage,
  computed: LifecycleStage,
  reason?: string,
): StageDecision {
  const delta = stageRank(computed) - stageRank(current);
  if (delta === 0) return { kind: "unchanged", stage: current };
  if (delta > 0) return { kind: "forward", stage: computed };
  const why = reason?.trim();
  if (why) return { kind: "backward", stage: computed, reason: why };
  return { kind: "held", stage: current, wanted: computed };
}

export interface StageHistoryEntry {
  stage: LifecycleStage;
  /** Required on any entry that is lower than the one before it. */
  reason?: string;
}

/** Indexes of entries that move backward without a reason. Empty when the history is valid. */
export function unrecordedRegressions(history: readonly StageHistoryEntry[]): number[] {
  const bad: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]!;
    const entry = history[i]!;
    if (stageRank(entry.stage) < stageRank(prev.stage) && !entry.reason?.trim()) bad.push(i);
  }
  return bad;
}

export interface ProfileOpportunities {
  profileId: string;
  stage: LifecycleStage;
  opportunities: readonly OpportunityFacts[];
}

/** Won profiles that have no opportunity with won = true. Empty when the data is consistent. */
export function wonWithoutWonOpportunity(profiles: readonly ProfileOpportunities[]): string[] {
  return profiles
    .filter((p) => p.stage === "won" && !p.opportunities.some((o) => o.won))
    .map((p) => p.profileId);
}
