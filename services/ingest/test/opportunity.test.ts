import { describe, expect, it } from "vitest";
import {
  auc,
  CUTOFF_VISIBLE_WEEKS,
  cutoffVisibleProbability,
  opportunityInputs,
  population,
  windowProbability,
} from "../src/ceiling.ts";
import { serialize, sha256 } from "../src/dataset.ts";
import { generate, WINDOW_END } from "../src/generator.ts";
import {
  DAY,
  drawOpportunities,
  featuresAt,
  firstOpenCdf,
  OPPORTUNITY_STREAM,
  type OpportunityPerson,
  weeklyHazard,
} from "../src/opportunity.ts";
import { Rng } from "../src/rng.ts";

const tables = generate({ seed: 42, people: 2_000, dobRate: 0.3 });

describe("Rng streams", () => {
  it("leaves stream 0 equal to the stream-less sequence", () => {
    const a = new Rng(42);
    const b = new Rng(42, 0);
    expect(Array.from({ length: 50 }, () => a.u32())).toEqual(
      Array.from({ length: 50 }, () => b.u32()),
    );
  });

  it("gives the opportunity stream a different sequence", () => {
    const a = new Rng(42);
    const b = new Rng(42, OPPORTUNITY_STREAM);
    expect(Array.from({ length: 50 }, () => a.u32())).not.toEqual(
      Array.from({ length: 50 }, () => b.u32()),
    );
  });
});

describe("generator version 3", () => {
  it("keeps every table except raw.crm_opportunity byte-identical to version 2 (seed 42)", () => {
    // From GENERATOR_VERSION 2's manifest for seed 42, 10,000 people, --dob-rate 0.3.
    const v2: Record<string, string> = {
      "raw/crm_contact.csv": "9d05c0b584dd6291aa805de07b6b7e8e56b4770269b0b0ae415a75c9672ccf88",
      "raw/web_event.csv": "e1c4a7021720981edcda5e4f9fb867b0d4cfd9f6c34dcca1bb13ab9f133c6b85",
      "raw/ad_click.csv": "f692fe0f3b0c7e1c1f672224d6a2b3ccf5dd1b77b67bd7d278774b0031472056",
      "eval/truth_record.csv": "948c5b5c9b5213a082cd71887e15b5688b9179b60013e0d5dc3ca5e96c4ba7ac",
      "eval/truth_hazard_pair.csv":
        "a080b15c087ba7f080d370a4fb564ebda4cffb4827952ea6b5aaf991fcd5b58a",
      "eval/truth_event.csv": "497a343cc81ba60d06d95ef71059f5c68a170f8fa655f5f136655afc80abeadb",
    };
    const files = serialize(generate({ seed: 42, people: 10_000, dobRate: 0.3 }));
    for (const [file, hash] of Object.entries(v2))
      expect(sha256(files.get(file)!), file).toBe(hash);
  });

  it("redraws the same opportunities from inputs rebuilt from the output tables", () => {
    const rng = new Rng(42, OPPORTUNITY_STREAM);
    const redrawn = opportunityInputs(tables).flatMap((p) =>
      drawOpportunities(rng, p.inputs, WINDOW_END).map(
        (o) => `${p.ownerCrmId}|${new Date(o.opened).toISOString()}|${o.stage}|${o.amount}`,
      ),
    );
    const actual = tables.crm_opportunity.map(
      (o) => `${o.crm_id}|${o.opened_at}|${o.stage}|${o.amount}`,
    );
    expect(redrawn.sort()).toEqual(actual.sort());
  });

  it("gives about a quarter of CRM people an opportunity", () => {
    const people = opportunityInputs(tables).length;
    const withOpp = new Set(tables.crm_opportunity.map((o) => o.crm_id)).size;
    expect(withOpp / people).toBeGreaterThan(0.2);
    expect(withOpp / people).toBeLessThan(0.3);
  });
});

describe("opportunity model", () => {
  const t0 = Date.UTC(2025, 5, 1);
  const person = (over: Partial<OpportunityPerson> = {}): OpportunityPerson => ({
    created: t0,
    title: "Data Analyst",
    sessionStarts: [],
    formTimes: [],
    ...over,
  });

  it("counts only activity strictly before the time asked", () => {
    const p = person({ sessionStarts: [t0 - DAY, t0], formTimes: [t0] });
    expect(featuresAt(p, t0)).toEqual({ seniority: 0, forms: 0, sessions: 1, recencyDays: 1 });
    expect(featuresAt(person(), t0).recencyDays).toBeNull();
  });

  it("raises the hazard with seniority, form fills, sessions and recency", () => {
    const base = { seniority: 0, forms: 0, sessions: 0, recencyDays: null };
    const h = weeklyHazard(base);
    expect(weeklyHazard({ ...base, seniority: 3 })).toBeGreaterThan(h);
    expect(weeklyHazard({ ...base, forms: 2 })).toBeGreaterThan(h);
    expect(weeklyHazard({ ...base, sessions: 5 })).toBeGreaterThan(h);
    expect(weeklyHazard({ ...base, recencyDays: 1 })).toBeGreaterThan(
      weeklyHazard({ ...base, recencyDays: 60 }),
    );
    expect(weeklyHazard({ ...base, forms: 3 })).toBe(weeklyHazard({ ...base, forms: 9 }));
  });

  it("keeps the first-opening CDF and window probability inside [0, 1]", () => {
    const p = person({ title: "CTO", sessionStarts: [t0 - 3 * DAY], formTimes: [t0 - DAY] });
    expect(firstOpenCdf(p, WINDOW_END, t0 - 1)).toBe(0);
    const all = firstOpenCdf(p, WINDOW_END, Infinity);
    expect(all).toBeGreaterThan(0);
    expect(all).toBeLessThan(1);
    const q = windowProbability(p, WINDOW_END, t0 + 30 * DAY, 90 * DAY);
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThan(1);
  });
});

describe("auc", () => {
  it("is 1 for a perfect ranking, 0 for a reversed one and 0.5 for all ties", () => {
    const labels = [false, false, true, true];
    expect(auc([1, 2, 3, 4], labels)).toBe(1);
    expect(auc([4, 3, 2, 1], labels)).toBe(0);
    expect(auc([1, 1, 1, 1], labels)).toBe(0.5);
  });

  it("counts a tied positive–negative pair as half", () => {
    // Pairs (pos, neg): (3,1) win, (3,2) win, (2,1) win, (2,2) tie → 3.5 / 4.
    expect(auc([1, 2, 2, 3], [false, false, true, true])).toBe(0.875);
  });

  it("refuses a single class", () => {
    expect(() => auc([1, 2], [true, true])).toThrow();
  });
});

describe("population", () => {
  it("holds profiles with a contact by the cutoff and no opportunity by then", () => {
    // Every contact its own profile: the stitch-free view.
    const own = new Map(tables.crm_contact.map((c) => [c.crm_id, c.crm_id]));
    const cutoff = Date.UTC(2026, 0, 1);
    const rows = population(tables, own, WINDOW_END, cutoff, 90 * DAY);
    const byId = new Map(tables.crm_contact.map((c) => [c.crm_id, c]));
    for (const r of rows) {
      expect(Date.parse(byId.get(r.profileId)!.updated_at)).toBeLessThanOrEqual(cutoff);
      expect(r.trueProbability).toBeGreaterThanOrEqual(0);
      expect(r.trueProbability).toBeLessThan(1);
    }
    for (const o of tables.crm_opportunity)
      if (Date.parse(o.opened_at) <= cutoff)
        expect(rows.some((r) => r.profileId === o.crm_id)).toBe(false);
    expect(rows.some((r) => r.label)).toBe(true);
  });
});

describe("cutoffVisibleProbability", () => {
  const t0 = Date.UTC(2025, 5, 1);
  const p: OpportunityPerson = {
    created: t0 - 30 * DAY,
    title: "CTO",
    sessionStarts: [t0 - 10 * DAY, t0 + 5 * DAY],
    formTimes: [t0 - 9 * DAY, t0 + 6 * DAY],
  };

  it("is 1 − (1 − h)^13 with inputs frozen at the cutoff", () => {
    const h = weeklyHazard(featuresAt(p, t0));
    expect(cutoffVisibleProbability(p, t0)).toBeCloseTo(1 - (1 - h) ** CUTOFF_VISIBLE_WEEKS, 15);
  });

  it("ignores activity after the cutoff", () => {
    const before = { ...p, sessionStarts: [t0 - 10 * DAY], formTimes: [t0 - 9 * DAY] };
    expect(cutoffVisibleProbability(p, t0)).toBe(cutoffVisibleProbability(before, t0));
  });

  it("is filled in for every population row", () => {
    const own = new Map(tables.crm_contact.map((c) => [c.crm_id, c.crm_id]));
    const rows = population(tables, own, WINDOW_END, Date.UTC(2026, 0, 1), 90 * DAY);
    for (const r of rows) {
      // 0 only for a profile that owns no one's opportunities (as for trueProbability).
      expect(r.cutoffVisibleProbability === 0).toBe(r.trueProbability === 0);
      expect(r.cutoffVisibleProbability).toBeLessThan(1);
    }
    expect(rows.some((r) => r.cutoffVisibleProbability > 0)).toBe(true);
  });
});
