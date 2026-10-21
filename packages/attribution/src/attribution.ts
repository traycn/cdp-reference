/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures until M6; remove with the implementation. */
/**
 * Pure attribution functions. Implement in Milestone 6.
 * Invariant (property-tested): for every conversion, credits sum to exactly 1.
 */

/** Matches the CHECK on core.touchpoint.channel. */
export type Channel =
  "paid_search" | "paid_social" | "organic" | "email" | "referral" | "direct" | "unattributed";

export interface Touchpoint {
  occurredAt: Date;
  channel: Channel;
}

export type Credits = Partial<Record<Channel, number>>;

export type Model = "first_touch" | "last_touch" | "linear" | "time_decay" | "position_based";

export interface AttributionOptions {
  /** Half-life in days for time_decay. Default 7. */
  halfLifeDays?: number;
  /** Lookback window in days; touchpoints older than this are ignored. Default 90. */
  lookbackDays?: number;
}

/** Touchpoints must be filtered to <= conversionAt and within the lookback window, then sorted ascending. */
export function attribute(
  touchpoints: Touchpoint[],
  conversionAt: Date,
  model: Model,
  opts: AttributionOptions = {},
): Credits {
  throw new Error("not implemented");
}

// Model-specific helpers — keep each small and individually tested.
export function firstTouch(tps: Touchpoint[]): Credits {
  throw new Error("not implemented");
}
export function lastTouch(tps: Touchpoint[]): Credits {
  throw new Error("not implemented");
}
export function linear(tps: Touchpoint[]): Credits {
  throw new Error("not implemented");
}
export function timeDecay(tps: Touchpoint[], conversionAt: Date, halfLifeDays: number): Credits {
  throw new Error("not implemented");
}
/** 40% first, 40% last, 20% split across middle. 1 tp → 100%; 2 tps → 50/50. */
export function positionBased(tps: Touchpoint[]): Credits {
  throw new Error("not implemented");
}
