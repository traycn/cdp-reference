/**
 * The leakage guard (docs/acceptance.md, Lead scoring; docs/plans/m5-lead-scoring.md):
 * nothing dated after the cutoff T may change any profile's score. Fixture: a small
 * generated dataset with profiles = true persons (no stitch needed). Scores use every
 * rule at weight 1, so a rule the fitted weights happen to zero is still checked.
 */
import { generate } from "@cdp/ingest/generator";
import {
  FEATURES,
  scoreFeatures,
  scoreSnapshot,
  type ScoreSnapshot,
  type ScoreWeights,
} from "@cdp/marketing-logic";
import { describe, expect, it } from "vitest";
import type { Dataset } from "../src/dataset.ts";
import { buildSnapshots } from "../src/snapshot.ts";

const DAY = 86_400_000;
const T = Date.UTC(2025, 9, 1);
const ALL_ONES: ScoreWeights = {
  halfLifeDays: 30,
  formCap: 3,
  points: Object.fromEntries(FEATURES.map((k) => [k, 1])) as ScoreWeights["points"],
};

/** A dataset whose profiles are the generator's true persons. */
function fixture(seed = 42, people = 600): Dataset {
  const t = generate({ seed, people, dobRate: 0.3 });
  const person = new Map(t.truth_record.map((r) => [`${r.unit_type}:${r.unit_key}`, r.person_id]));
  const links: Dataset["links"] = [];
  for (const c of t.crm_contact)
    links.push({
      idType: "crm_id",
      idValue: c.crm_id,
      profileId: person.get(`crm_contact:${c.crm_id}`)!,
    });
  for (const e of t.web_event)
    if (e.event_name === "form_submit")
      links.push({
        idType: "form_submission",
        idValue: e.source_event_id,
        profileId: person.get(`form_submission:${e.source_event_id}`)!,
      });
  return {
    profiles: [...new Set(links.map((l) => l.profileId))].sort(),
    links,
    contacts: t.crm_contact.map((c) => ({
      crmId: c.crm_id,
      email: c.email?.trim().toLowerCase() ?? null,
      emailVerified: c.email_verified,
      title: c.title,
      updatedAt: Date.parse(c.updated_at),
    })),
    webEvents: t.web_event.map((e) => ({
      id: e.source_event_id,
      device: e.anonymous_id,
      at: Date.parse(e.occurred_at),
      kind: e.event_name,
      path: e.page_path,
      session: e.properties.session_id ?? null,
    })),
    adClicks: t.ad_click
      .filter((c) => c.anonymous_id !== null)
      .map((c) => ({
        id: c.source_event_id,
        device: c.anonymous_id!,
        at: Date.parse(c.occurred_at),
      })),
    opportunities: t.crm_opportunity.map((o) => ({
      oppId: o.opp_id,
      crmId: o.crm_id,
      openedAt: Date.parse(o.opened_at),
    })),
  };
}

const base = fixture();

function scores(
  d: Dataset,
): Map<string, { snapshot: ScoreSnapshot; features: number[]; total: number }> {
  const out = new Map<string, { snapshot: ScoreSnapshot; features: number[]; total: number }>();
  // Score the base dataset's profiles, so added or removed profiles can't hide a change.
  for (const [p, s] of buildSnapshots(d, T, base.profiles)) {
    const f = scoreFeatures(s, ALL_ONES);
    out.set(p, {
      snapshot: s,
      features: FEATURES.map((k) => f[k]),
      total: scoreSnapshot(s, ALL_ONES).total,
    });
  }
  return out;
}

const expected = scores(base);

function expectUnchanged(d: Dataset): void {
  const got = scores(d);
  expect(got.size).toBe(expected.size);
  for (const [p, e] of expected) {
    const g = got.get(p)!;
    // Bit-identical: Object.is on every feature, deep equality on the snapshot.
    g.features.forEach((x, i) =>
      expect(Object.is(x, e.features[i]), `${p} ${FEATURES[i]}`).toBe(true),
    );
    expect(g.total).toBe(e.total);
    expect(g.snapshot).toEqual(e.snapshot);
  }
}

/** Applies `f` to every time-stamped row dated at or after T (contacts: after T). */
function mapAfter(d: Dataset, f: (at: number) => number | null): Dataset {
  const keepEvent = <R extends { at: number }>(rows: R[]): R[] =>
    rows.flatMap((r) => {
      if (r.at < T) return [r];
      const at = f(r.at);
      return at === null ? [] : [{ ...r, at }];
    });
  return {
    ...d,
    webEvents: keepEvent(d.webEvents),
    adClicks: keepEvent(d.adClicks),
    contacts: d.contacts.flatMap((c) => {
      if (c.updatedAt <= T) return [c];
      const at = f(c.updatedAt);
      return at === null ? [] : [{ ...c, updatedAt: Math.max(at, T + 1) }];
    }),
    opportunities: d.opportunities.flatMap((o) => {
      if (o.openedAt <= T) return [o];
      const at = f(o.openedAt);
      return at === null ? [] : [{ ...o, openedAt: at }];
    }),
  };
}

describe("leakage guard", () => {
  it("has rows after T in every table, so the test can bite", () => {
    expect(base.webEvents.some((e) => e.at >= T && e.kind === "form_submit")).toBe(true);
    expect(base.webEvents.some((e) => e.at >= T && e.kind === "page_view")).toBe(true);
    expect(base.adClicks.some((c) => c.at >= T)).toBe(true);
    expect(base.contacts.some((c) => c.updatedAt > T)).toBe(true);
    expect(base.opportunities.some((o) => o.openedAt > T)).toBe(true);
    expect([...expected.values()].some((e) => e.total > 0)).toBe(true);
  });

  it("ignores deleting every row dated after T", () => {
    expectUnchanged(mapAfter(base, () => null));
  });

  it("ignores shifting rows after T by +30 days", () => {
    expectUnchanged(mapAfter(base, (at) => at + 30 * DAY));
  });

  it("ignores shifting rows after T by −30 days, staying after T", () => {
    expectUnchanged(mapAfter(base, (at) => (at - 30 * DAY >= T ? at - 30 * DAY : at)));
  });

  it("ignores new rows after T: events, form fills on existing devices, contacts, opportunities", () => {
    const d: Dataset = structuredClone(base);
    const devices = [...new Set(base.webEvents.map((e) => e.device))];
    const sessions = [...new Set(base.webEvents.flatMap((e) => (e.session ? [e.session] : [])))];
    const profiles = base.profiles;
    let n = 0;
    const id = (prefix: string): string => `${prefix}X${String(++n).padStart(7, "0")}`;
    devices.forEach((device, i) => {
      const session = sessions[i % sessions.length]!;
      // A page view at T itself and later ones, in existing sessions, on intent pages.
      d.webEvents.push({
        id: id("W"),
        device,
        at: T,
        kind: "page_view",
        path: "/pricing",
        session,
      });
      d.webEvents.push({
        id: id("W"),
        device,
        at: T + 60_000,
        kind: "page_view",
        path: "/demo",
        session,
      });
      // A form fill on the device, linked to some other profile.
      const fill = id("W");
      d.webEvents.push({
        id: fill,
        device,
        at: T + 3_600_000,
        kind: "form_submit",
        path: "/demo",
        session,
      });
      d.links.push({
        idType: "form_submission",
        idValue: fill,
        profileId: profiles[(i * 7) % profiles.length]!,
      });
      d.adClicks.push({ id: id("A"), device, at: T + 5_000 });
    });
    // Pre-T clicks close to T: a post-T event within 30 minutes must not give them a session.
    for (const c of base.adClicks)
      if (c.at < T && c.at > T - 30 * 60_000)
        d.webEvents.push({
          id: id("W"),
          device: c.device,
          at: T + 1_000,
          kind: "page_view",
          path: "/",
          session: sessions[0]!,
        });
    for (const [i, p] of profiles.entries()) {
      const crmId = id("C");
      d.contacts.push({
        crmId,
        email: "ceo@bigco.example.co",
        emailVerified: true,
        title: "CEO",
        updatedAt: T + DAY,
      });
      d.links.push({ idType: "crm_id", idValue: crmId, profileId: p });
      if (i % 3 === 0) d.opportunities.push({ oppId: id("O"), crmId, openedAt: T + 2 * DAY });
    }
    expectUnchanged(d);
  });

  it("ignores a post-T event within 30 minutes of a pre-T ad click", () => {
    // d1 has fills from A and B, so no device link: only a session can carry the click.
    const small: Dataset = {
      profiles: ["A", "B"],
      links: [
        { idType: "form_submission", idValue: "F1", profileId: "A" },
        { idType: "form_submission", idValue: "F2", profileId: "B" },
      ],
      contacts: [],
      webEvents: [
        {
          id: "F1",
          device: "d1",
          at: T - 2 * DAY,
          kind: "form_submit",
          path: "/demo",
          session: "s1",
        },
        {
          id: "F2",
          device: "d1",
          at: T - 3 * DAY,
          kind: "form_submit",
          path: "/demo",
          session: "s2",
        },
      ],
      adClicks: [{ id: "A1", device: "d1", at: T - 10 * 60_000 }],
      opportunities: [],
    };
    const later: Dataset = structuredClone(small);
    later.webEvents.push({
      id: "W9",
      device: "d1",
      at: T + 60_000,
      kind: "page_view",
      path: "/",
      session: "s1",
    });
    expect(buildSnapshots(small, T).get("A")!.adClicks).toEqual([]);
    expect(buildSnapshots(later, T)).toEqual(buildSnapshots(small, T));
  });

  it("does see a change before T (the test is not blind)", () => {
    const d: Dataset = structuredClone(base);
    const p = base.profiles[0]!;
    d.webEvents.push({
      id: "WPRE0000001",
      device: "fresh-device",
      at: T - DAY,
      kind: "form_submit",
      path: "/demo",
      session: "s_pre",
    });
    d.links.push({ idType: "form_submission", idValue: "WPRE0000001", profileId: p });
    const before = expected.get(p)!;
    const after = scores(d).get(p)!;
    expect(after.snapshot.formFills.length).toBe(before.snapshot.formFills.length + 1);
    expect(after.features).not.toEqual(before.features);
  });
});
