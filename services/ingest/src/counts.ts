/**
 * Row-count checks from docs/acceptance.md ("Row counts" and "Ground-truth and
 * form counts"). Ranges are per 10,000 people and scale linearly with --people.
 * The same checks run on generator output and on the loaded database.
 */
import type { HazardKind, PersonKind, Tables } from "./tables.ts";

export type DobGroup = "both" | "one" | "none";

export interface Counts {
  crm_contact: number;
  crm_opportunity: number;
  web_event: number;
  ad_click: number;
  form_submission: number;
  /** Distinct non-null anonymous_id across web_event and ad_click. */
  event_devices: number;
  contacts_with_dob: number;
  truth_crm_contact: number;
  truth_form_submission: number;
  truth_device: number;
  persons: number;
  kinds: Record<PersonKind, number>;
  hazard_pairs: Record<HazardKind, number>;
  hazard_dob_groups: Record<HazardKind, Record<DobGroup, number>>;
}

export interface Check {
  name: string;
  value: number | string;
  expected: string;
  ok: boolean;
}

/** Per 10,000 people, from docs/acceptance.md. */
export const RANGES = {
  crm_contact: [6_000, 8_000],
  ad_click: [30_000, 60_000],
  web_event: [150_000, 300_000],
  crm_opportunity: [1_500, 2_500],
  form_submission: [7_500, 10_500],
  truth_device: [11_000, 12_700],
  kind_ordinary: [7_300, 7_900],
  kind_multi_email: [500, 700],
  kind_multi_device: [1_300, 1_700],
  kind_email_changed: [250, 350],
} as const satisfies Record<string, readonly [number, number]>;

export const HAZARD_PAIRS_PER_PERSON = 0.015;
const MIN_PAIRS_PER_DOB_GROUP = 40;
const DOB_RATE_TOLERANCE = 0.02;

export const HAZARD_KINDS: readonly HazardKind[] = ["same_name_relative", "shared_household_phone"];
export const PERSON_KINDS: readonly PersonKind[] = [
  "ordinary",
  "multi_email",
  "multi_device",
  "email_changed",
];

export function checkCounts(c: Counts, people: number, dobRate: number): Check[] {
  const scale = people / 10_000;
  const fmt = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const range = (name: string, value: number, [lo, hi]: readonly [number, number]): Check => ({
    name,
    value,
    expected: `${fmt(lo * scale)}–${fmt(hi * scale)}`,
    ok: value >= lo * scale && value <= hi * scale,
  });
  const equal = (name: string, value: number, expected: number, label: string): Check => ({
    name,
    value,
    expected: `= ${label} (${expected})`,
    ok: value === expected,
  });

  const checks: Check[] = [
    range("raw.crm_contact", c.crm_contact, RANGES.crm_contact),
    range("raw.ad_click", c.ad_click, RANGES.ad_click),
    range("raw.web_event", c.web_event, RANGES.web_event),
    range("raw.crm_opportunity", c.crm_opportunity, RANGES.crm_opportunity),
    range("form submissions", c.form_submission, RANGES.form_submission),
    equal("truth crm_contact", c.truth_crm_contact, c.crm_contact, "raw.crm_contact"),
    equal("truth form_submission", c.truth_form_submission, c.form_submission, "form submissions"),
    range("truth device", c.truth_device, RANGES.truth_device),
    equal("truth device = event devices", c.truth_device, c.event_devices, "event devices"),
    equal("distinct persons", c.persons, people, "--people"),
  ];
  for (const kind of PERSON_KINDS) {
    checks.push(range(`kind ${kind}`, c.kinds[kind], RANGES[`kind_${kind}`]));
  }
  const pairs = Math.round(people * HAZARD_PAIRS_PER_PERSON);
  for (const kind of HAZARD_KINDS) {
    checks.push(equal(`hazard ${kind}`, c.hazard_pairs[kind], pairs, "round(0.015 × people)"));
    if (dobRate > 0 && dobRate < 1) {
      for (const group of ["both", "one", "none"] as const) {
        const value = c.hazard_dob_groups[kind][group];
        const min = MIN_PAIRS_PER_DOB_GROUP * scale;
        checks.push({
          name: `hazard ${kind} dob ${group}`,
          value,
          expected: `≥ ${fmt(min)}`,
          ok: value >= min,
        });
      }
    }
  }
  const rate = c.crm_contact === 0 ? 0 : c.contacts_with_dob / c.crm_contact;
  checks.push({
    name: "dob rate",
    value: rate.toFixed(4),
    expected: `${(dobRate - DOB_RATE_TOLERANCE).toFixed(2)}–${(dobRate + DOB_RATE_TOLERANCE).toFixed(2)}`,
    ok: Math.abs(rate - dobRate) <= DOB_RATE_TOLERANCE + 1e-12,
  });
  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const w = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map(
      (c) =>
        `${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(w)}  ${String(c.value).padStart(8)}  ${c.expected}`,
    )
    .join("\n");
}

/** Counts from in-memory tables (generator side). */
export function countTables(t: Tables): Counts {
  const forms = t.web_event.filter((e) => e.event_name === "form_submit");
  const devices = new Set<string>();
  for (const e of t.web_event) devices.add(e.anonymous_id);
  for (const c of t.ad_click) if (c.anonymous_id !== null) devices.add(c.anonymous_id);

  const kinds = Object.fromEntries(PERSON_KINDS.map((k) => [k, 0])) as Counts["kinds"];
  const kindOf = new Map<string, PersonKind>();
  for (const r of t.truth_record) kindOf.set(r.person_id, r.person_kind);
  for (const k of kindOf.values()) kinds[k]++;

  const dobByPerson = new Map<string, boolean>();
  const dobByCrmId = new Map(t.crm_contact.map((c) => [c.crm_id, c.dob !== null]));
  for (const r of t.truth_record) {
    if (r.unit_type === "crm_contact") dobByPerson.set(r.person_id, dobByCrmId.get(r.unit_key)!);
  }
  const hazardPairs = { same_name_relative: 0, shared_household_phone: 0 };
  const groups = {
    same_name_relative: { both: 0, one: 0, none: 0 },
    shared_household_phone: { both: 0, one: 0, none: 0 },
  };
  for (const h of t.truth_hazard_pair) {
    hazardPairs[h.kind]++;
    const n = Number(dobByPerson.get(h.person_a)) + Number(dobByPerson.get(h.person_b));
    groups[h.kind][n === 2 ? "both" : n === 1 ? "one" : "none"]++;
  }

  const unitCount = (type: string): number =>
    t.truth_record.filter((r) => r.unit_type === type).length;
  return {
    crm_contact: t.crm_contact.length,
    crm_opportunity: t.crm_opportunity.length,
    web_event: t.web_event.length,
    ad_click: t.ad_click.length,
    form_submission: forms.length,
    event_devices: devices.size,
    contacts_with_dob: t.crm_contact.filter((c) => c.dob !== null).length,
    truth_crm_contact: unitCount("crm_contact"),
    truth_form_submission: unitCount("form_submission"),
    truth_device: unitCount("device"),
    persons: kindOf.size,
    kinds,
    hazard_pairs: hazardPairs,
    hazard_dob_groups: groups,
  };
}
