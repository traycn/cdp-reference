/**
 * The M5 ceiling (docs/acceptance.md, change log 2026-10-23): the AUC of the
 * generator's true probabilities on the lead-score population.
 *
 * Each person's opportunity-model inputs are rebuilt from the output tables
 * alone (CRM contacts, web events, eval.truth_record, eval.truth_event), so the
 * truth is exactly what the generator used; a test redraws the opportunities
 * from these inputs and requires the same rows.
 */
import type pg from "pg";
import {
  DAY,
  featuresAt,
  firstOpenCdf,
  weeklyHazard,
  type OpportunityPerson,
} from "./opportunity.ts";
import type { Tables } from "./tables.ts";

/** Cutoff and label window of the M5 measure, the same for every seed. */
export const CUTOFF = Date.UTC(2026, 0, 1);
export const HORIZON = 90 * DAY;

export interface PersonInputs {
  personId: string;
  /** The contact that owns the person's opportunities: the latest by updated_at, then crm_id. */
  ownerCrmId: string;
  inputs: OpportunityPerson;
}

const byTimeThenId = <T extends { t: number; id: string }>(a: T, b: T): number =>
  a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One entry per CRM person, in person_id order (the generator's draw order). */
export function opportunityInputs(t: Tables): PersonInputs[] {
  const personOfContact = new Map<string, string>();
  const personOfEvent = new Map<string, string>();
  for (const r of t.truth_record)
    if (r.unit_type === "crm_contact") personOfContact.set(r.unit_key, r.person_id);
  for (const r of t.truth_event)
    if (r.source_table === "web_event") personOfEvent.set(r.source_event_id, r.person_id);

  const contacts = new Map<string, { t: number; id: string; title: string }[]>();
  for (const c of t.crm_contact) {
    const person = personOfContact.get(c.crm_id)!;
    const entry = { t: Date.parse(c.updated_at), id: c.crm_id, title: c.title ?? "" };
    contacts.set(person, [...(contacts.get(person) ?? []), entry]);
  }

  // A session's start is its first page view; every event of a session has one producer.
  const sessionStart = new Map<string, { person: string; t: number }>();
  const forms = new Map<string, number[]>();
  for (const e of t.web_event) {
    const person = personOfEvent.get(e.source_event_id)!;
    const at = Date.parse(e.occurred_at);
    if (e.event_name === "form_submit") {
      forms.set(person, [...(forms.get(person) ?? []), at]);
      continue;
    }
    const key = `${person}|${e.properties.session_id}`;
    const seen = sessionStart.get(key);
    if (!seen || at < seen.t) sessionStart.set(key, { person, t: at });
  }
  const sessions = new Map<string, number[]>();
  for (const { person, t: at } of sessionStart.values())
    sessions.set(person, [...(sessions.get(person) ?? []), at]);

  return [...contacts.keys()].sort().map((personId) => {
    const owner = contacts.get(personId)!.sort(byTimeThenId).at(-1)!;
    return {
      personId,
      ownerCrmId: owner.id,
      inputs: {
        created: owner.t,
        title: owner.title,
        sessionStarts: (sessions.get(personId) ?? []).sort((a, b) => a - b),
        formTimes: (forms.get(personId) ?? []).sort((a, b) => a - b),
      },
    };
  });
}

/** P(first opportunity opens in (cutoff, cutoff + horizon] | none opened by cutoff). */
export function windowProbability(
  p: OpportunityPerson,
  windowEnd: number,
  cutoff = CUTOFF,
  horizon = HORIZON,
): number {
  const before = firstOpenCdf(p, windowEnd, cutoff);
  const by = firstOpenCdf(p, windowEnd, cutoff + horizon);
  return before >= 1 ? 0 : (by - before) / (1 - before);
}

/** Rank-based AUC (Mann–Whitney U), ties counted as half. */
export function auc(scores: readonly number[], labels: readonly boolean[]): number {
  if (scores.length !== labels.length) throw new Error("scores and labels differ in length");
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  const rank = new Array<number>(scores.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.s === order[i]!.s) j++;
    for (let k = i; k <= j; k++) rank[order[k]!.i] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let pos = 0;
  let rankSum = 0;
  labels.forEach((l, i) => {
    if (l) {
      pos++;
      rankSum += rank[i]!;
    }
  });
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) throw new Error("AUC needs both positives and negatives");
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export interface PopulationRow {
  profileId: string;
  label: boolean;
  trueProbability: number;
  /** Diagnostic, report only: see cutoffVisibleProbability. */
  cutoffVisibleProbability: number;
}

/** Weeks in the cutoff-visible ceiling's window (13 weeks ≈ the 90-day horizon). */
export const CUTOFF_VISIBLE_WEEKS = 13;

/**
 * The "cutoff-visible ceiling" (docs/acceptance.md, change log 2026-10-26; defined
 * after the measure-cutoff numbers were seen, report only): the generator's weekly
 * hazard with every input frozen at its value at the cutoff (activity strictly
 * before it, none after), as 1 − (1 − h)^13.
 */
export function cutoffVisibleProbability(p: OpportunityPerson, cutoff = CUTOFF): number {
  return 1 - (1 - weeklyHazard(featuresAt(p, cutoff))) ** CUTOFF_VISIBLE_WEEKS;
}

/**
 * The M5 population: profiles holding a CRM contact created (updated_at) on or
 * before the cutoff and no opportunity opened on or before it. Label: an
 * opportunity on any of the profile's contacts opens in (cutoff, cutoff + horizon].
 * True probability: 1 − ∏ (1 − windowProbability) over the CRM persons whose
 * opportunity-owning contact is in the profile; the cutoff-visible probability
 * combines cutoffVisibleProbability the same way.
 */
export function population(
  t: Tables,
  profileOfContact: ReadonlyMap<string, string>,
  windowEnd: number,
  cutoff = CUTOFF,
  horizon = HORIZON,
): PopulationRow[] {
  const profileOf = (crmId: string): string => {
    const p = profileOfContact.get(crmId);
    if (p === undefined) throw new Error(`CRM contact ${crmId} has no profile`);
    return p;
  };
  const eligible = new Set<string>();
  for (const c of t.crm_contact)
    if (Date.parse(c.updated_at) <= cutoff) eligible.add(profileOf(c.crm_id));
  const converted = new Set<string>();
  const positive = new Set<string>();
  for (const o of t.crm_opportunity) {
    const at = Date.parse(o.opened_at);
    if (at <= cutoff) converted.add(profileOf(o.crm_id));
    else if (at <= cutoff + horizon) positive.add(profileOf(o.crm_id));
  }
  const miss = new Map<string, number>();
  const missVisible = new Map<string, number>();
  for (const { ownerCrmId, inputs } of opportunityInputs(t)) {
    const profile = profileOf(ownerCrmId);
    const q = windowProbability(inputs, windowEnd, cutoff, horizon);
    miss.set(profile, (miss.get(profile) ?? 1) * (1 - q));
    const v = cutoffVisibleProbability(inputs, cutoff);
    missVisible.set(profile, (missVisible.get(profile) ?? 1) * (1 - v));
  }
  return [...eligible]
    .filter((p) => !converted.has(p))
    .sort()
    .map((profileId) => ({
      profileId,
      label: positive.has(profileId),
      trueProbability: 1 - (miss.get(profileId) ?? 1),
      cutoffVisibleProbability: 1 - (missVisible.get(profileId) ?? 1),
    }));
}

/**
 * Throws unless the database holds exactly these opportunities, i.e. the seed the
 * tables were generated from; otherwise its profiles belong to another dataset.
 */
export async function assertDatabaseHolds(
  client: pg.Client,
  t: Tables,
  seed: number,
): Promise<void> {
  const loaded = await client.query<{ opp_id: string; crm_id: string; opened_at: Date }>(
    `SELECT opp_id, crm_id, opened_at FROM raw.crm_opportunity`,
  );
  const key = (id: string, crm: string, at: Date): string => `${id}|${crm}|${at.toISOString()}`;
  const inDb = new Set(loaded.rows.map((r) => key(r.opp_id, r.crm_id, r.opened_at)));
  const expected = t.crm_opportunity.map((o) => key(o.opp_id, o.crm_id, new Date(o.opened_at)));
  if (inDb.size !== expected.length || expected.some((k) => !inDb.has(k)))
    throw new Error(`the database does not hold seed ${seed}; run scripts/seed.sh first`);
}
