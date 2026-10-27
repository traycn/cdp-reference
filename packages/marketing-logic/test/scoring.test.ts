import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  decay,
  FEATURES,
  isBusinessEmail,
  parseScoreWeights,
  points,
  scoreFeatures,
  scoreSnapshot,
  seniority,
  type ScoreSnapshot,
  type ScoreWeights,
} from "../src/index.ts";
import { SCORE_WEIGHTS } from "../src/weights.ts";

const T = Date.UTC(2026, 0, 1);
const H = 30;
const empty: ScoreSnapshot = {
  asOf: T,
  contact: null,
  formFills: [],
  sessionStarts: [],
  intentPageViews: [],
  adClicks: [],
  lastEventAt: null,
};
const ones = (over: Partial<ScoreWeights["points"]> = {}): ScoreWeights => ({
  halfLifeDays: H,
  formCap: 3,
  points: {
    ...(Object.fromEntries(FEATURES.map((k) => [k, 0])) as ScoreWeights["points"]),
    ...over,
  },
});
const days = (n: number): number => T - n * DAY_MS;

describe("F1 seniority", () => {
  it.each([
    ["Founder", 3],
    ["CTO", 3],
    ["Chief Revenue Officer", 3],
    ["VP Marketing", 3],
    ["Vice President, Sales", 3],
    ["Head of Growth", 2],
    ["Sales Director", 2],
    ["Marketing Manager", 1],
    ["Demand Gen Lead", 1],
    ["Office Manager", 1],
    ["Data Analyst", 0],
    ["Software Engineer", 0],
    ["Consultant", 0],
  ])("%s → %i", (title, level) => {
    expect(seniority(title)).toBe(level);
  });

  it("checks executive before director before manager", () => {
    expect(seniority("VP and Product Manager")).toBe(3);
    expect(seniority("Director, Lead Generation")).toBe(2);
  });

  it("matches whole words only, any case", () => {
    expect(seniority("vp marketing")).toBe(3);
    expect(seniority("Leadership coach")).toBe(0);
    expect(seniority("Vpn admin")).toBe(0);
  });

  it("gives 0 for a missing or empty title", () => {
    expect(seniority(null)).toBe(0);
    expect(seniority(undefined)).toBe(0);
    expect(seniority("")).toBe(0);
  });
});

describe("F2 business email and F3 verified email", () => {
  it("counts a domain outside the personal-mail list as business", () => {
    expect(isBusinessEmail("ana@acme.example.com")).toBe(true);
    expect(isBusinessEmail(" Ana@Example.COM ")).toBe(false);
    expect(isBusinessEmail("ana@example.net")).toBe(false);
    expect(isBusinessEmail("ana@example.org")).toBe(false);
    expect(isBusinessEmail("no-at-sign")).toBe(false);
    expect(isBusinessEmail("ana@")).toBe(false);
    expect(isBusinessEmail(null)).toBe(false);
  });

  it("reads both from the snapshot's contact; no contact gives 0", () => {
    const s = {
      ...empty,
      contact: { title: "CTO", email: "a@acme.example.com", emailVerified: true },
    };
    const f = scoreFeatures(s, ones());
    expect([f.seniority, f.businessEmail, f.verifiedEmail]).toEqual([3, 1, 1]);
    const g = scoreFeatures({ ...s, contact: { ...s.contact, emailVerified: null } }, ones());
    expect(g.verifiedEmail).toBe(0);
    const n = scoreFeatures(empty, ones());
    expect([n.seniority, n.businessEmail, n.verifiedEmail]).toEqual([0, 0, 0]);
  });
});

describe("decay", () => {
  it("halves every half-life", () => {
    expect(decay(0, H)).toBe(1);
    expect(decay(H, H)).toBe(0.5);
    expect(decay(2 * H, H)).toBe(0.25);
  });

  it("falls monotonically with age", () => {
    let prev = Infinity;
    for (const d of [0, 1, 7, 30, 90, 365]) {
      const v = decay(d, H);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });

  it("refuses a non-positive half-life", () => {
    expect(() => decay(1, 0)).toThrow();
  });
});

describe("engagement rules", () => {
  it("E1 sums decayed form fills, capped", () => {
    const f = scoreFeatures({ ...empty, formFills: [days(0) - 1, days(H)] }, ones());
    expect(f.formFills).toBeCloseTo(1.5, 6);
    const many = scoreFeatures({ ...empty, formFills: [1, 2, 3, 4, 5].map((n) => T - n) }, ones());
    expect(many.formFills).toBe(3);
  });

  it("E2 is ln(1 + decayed sessions)", () => {
    const f = scoreFeatures({ ...empty, sessionStarts: [days(H), days(H)] }, ones());
    expect(f.sessions).toBeCloseTo(Math.log(2), 12);
  });

  it("E3 and E4 sum decayed intent page views and ad clicks", () => {
    const f = scoreFeatures(
      { ...empty, intentPageViews: [days(H)], adClicks: [days(2 * H), days(2 * H)] },
      ones(),
    );
    expect(f.intentPages).toBeCloseTo(0.5, 12);
    expect(f.adClicks).toBeCloseTo(0.5, 12);
  });

  it("E5 decays from the last event; 0 with none", () => {
    expect(scoreFeatures({ ...empty, lastEventAt: days(H) }, ones()).recency).toBe(0.5);
    expect(scoreFeatures(empty, ones()).recency).toBe(0);
  });

  it("excludes an event at exactly asOf and includes one a millisecond earlier", () => {
    const at = scoreFeatures({ ...empty, formFills: [T], adClicks: [T], lastEventAt: T }, ones());
    expect([at.formFills, at.adClicks, at.recency]).toEqual([0, 0, 0]);
    const before = scoreFeatures({ ...empty, formFills: [T - 1], lastEventAt: T - 1 }, ones());
    expect(before.formFills).toBeGreaterThan(0.999);
    expect(before.recency).toBeGreaterThan(0.999);
  });
});

describe("points and rounding", () => {
  const s: ScoreSnapshot = {
    ...empty,
    contact: { title: "Head of Growth", email: "x@acme.example.com", emailVerified: false },
    formFills: [days(H)],
    sessionStarts: [days(0) - 1],
    lastEventAt: days(H),
  };
  const w = ones({ seniority: 10.5, businessEmail: 3, formFills: 7, sessions: 4.5, recency: 9 });

  it("splits points into fit and engagement", () => {
    const p = points(scoreFeatures(s, w), w);
    expect(p.fit).toBeCloseTo(2 * 10.5 + 3, 9);
    expect(p.engagement).toBeCloseTo(7 * 0.5 + 4.5 * Math.log(2) + 9 * 0.5, 6);
  });

  it("rounds each part to an integer and adds them", () => {
    const r = scoreSnapshot(s, w);
    expect(Number.isInteger(r.fit) && Number.isInteger(r.engagement)).toBe(true);
    expect(r.fit).toBe(24);
    expect(r.engagement).toBe(Math.round(3.5 + 4.5 * Math.log(2) + 4.5));
    expect(r.total).toBe(r.fit + r.engagement);
  });
});

describe("score weights", () => {
  it("parses a valid file and rejects bad ones", () => {
    const ok = { halfLifeDays: 30, formCap: 3, points: ones().points, extra: 1 };
    expect(parseScoreWeights(ok)).toEqual({ halfLifeDays: 30, formCap: 3, points: ones().points });
    expect(() => parseScoreWeights(null)).toThrow("halfLifeDays");
    expect(() => parseScoreWeights({ ...ok, formCap: 0 })).toThrow("formCap");
    expect(() => parseScoreWeights({ ...ok, points: { ...ok.points, recency: -1 } })).toThrow(
      "points.recency",
    );
    expect(() => parseScoreWeights({ ...ok, points: {} })).toThrow("points.seniority");
  });

  it("ships fitted weights that parse", () => {
    expect(SCORE_WEIGHTS.halfLifeDays).toBeGreaterThan(0);
    expect(Object.keys(SCORE_WEIGHTS.points).sort()).toEqual([...FEATURES].sort());
  });
});
