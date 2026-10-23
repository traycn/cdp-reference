import { describe, expect, it } from "vitest";
import {
  CONVERSION_KINDS,
  LIFECYCLE_STAGES,
  OPPORTUNITY_STAGES,
  adClickChannel,
  advanceStage,
  channelFor,
  isInternalReferrer,
  lifecycleStage,
  mqlOccurredAt,
  opportunityStageReached,
  sessionChannels,
  stageRank,
  unrecordedRegressions,
  wonWithoutWonOpportunity,
  type LifecycleFacts,
  type OpportunityFacts,
} from "../src/definitions.ts";
import { AD_CLICK_CASES, CHANNEL_CASES } from "./channel-cases.ts";

const FORM = new Date("2025-03-01T10:00:00Z");
const opp = (stage: string, won = false): OpportunityFacts => ({ stage, won });
const facts = (firstFormAt: Date | null, ...opportunities: OpportunityFacts[]): LifecycleFacts => ({
  firstFormAt,
  opportunities,
});

describe("channels (the shared case table, definitions.ts side)", () => {
  it.each(CHANNEL_CASES.filter((c) => !c.session))("$name", (c) => {
    const e = c.events[0]!;
    expect(channelFor({ utmSource: e.source, utmMedium: e.medium, referrer: e.referrer })).toBe(
      c.expected[0],
    );
  });

  it.each(CHANNEL_CASES.filter((c) => c.session))("$name", (c) => {
    const events = c.events.map((e, j) => ({
      id: `e${j}`,
      occurredAt: new Date(Date.UTC(2025, 2, 1, 0, 0, j)),
      sessionId: "s1",
      utmSource: e.source,
      utmMedium: e.medium,
      referrer: e.referrer,
    }));
    const got = sessionChannels(events);
    expect(events.map((e) => got.get(e.id))).toEqual(c.expected);
  });

  it.each(AD_CLICK_CASES)("ad click: $name", (c) => {
    expect(adClickChannel({ platform: c.platform, utmSource: c.source, utmMedium: c.medium })).toBe(
      c.expected,
    );
  });

  it("a medium named like a prototype key is unattributed", () => {
    expect(channelFor({ utmMedium: "constructor" })).toBe("unattributed");
  });

  it("only the site host and its subdomains are internal", () => {
    expect(isInternalReferrer("https://www.northbeam-cdp.example/a")).toBe(true);
    expect(isInternalReferrer("https://example.com/")).toBe(false);
    expect(isInternalReferrer(null)).toBe(false);
  });

  it("events without a session keep their own channel, in any order", () => {
    const got = sessionChannels([
      { id: "b", occurredAt: new Date(2), referrer: "https://www.google.com/" },
      { id: "a", occurredAt: new Date(1) },
    ]);
    expect(got.get("a")).toBe("direct");
    expect(got.get("b")).toBe("organic");
  });

  it("the entry event is the earliest, whatever the input order; a tie goes to the smaller id", () => {
    const at = new Date(5);
    const got = sessionChannels([
      { id: "late", occurredAt: new Date(9), sessionId: "s" },
      { id: "tie_b", occurredAt: at, sessionId: "s", referrer: "https://other.example/" },
      { id: "tie_a", occurredAt: at, sessionId: "s", referrer: "https://www.google.com/" },
      { id: "early", occurredAt: new Date(7), sessionId: "s", referrer: "https://other.example/" },
    ]);
    expect([...got.values()]).toEqual(["organic", "organic", "organic", "organic"]);
    const earlier = sessionChannels([
      { id: "z", occurredAt: new Date(1), sessionId: "s", utmMedium: "email" },
      { id: "a", occurredAt: new Date(2), sessionId: "s" },
    ]);
    expect(earlier.get("a")).toBe("email");
  });

  it("separate sessions are decided separately", () => {
    const got = sessionChannels([
      { id: "1", occurredAt: new Date(1), sessionId: "s1", utmMedium: "cpc" },
      { id: "2", occurredAt: new Date(2), sessionId: "s2" },
    ]);
    expect(got.get("1")).toBe("paid_search");
    expect(got.get("2")).toBe("direct");
  });
});

describe("conversion kinds", () => {
  it("are won and mql", () => {
    expect(CONVERSION_KINDS).toEqual(["won", "mql"]);
  });
});

describe("lifecycle stage boundaries", () => {
  it("stages are ordered lead < mql < sql < opportunity < won", () => {
    expect(LIFECYCLE_STAGES.map(stageRank)).toEqual([0, 1, 2, 3, 4]);
  });

  describe("lead → mql: a form submission", () => {
    it("no form, no opportunity: lead", () => {
      expect(lifecycleStage(facts(null))).toBe("lead");
    });
    it("one form submission: mql", () => {
      expect(lifecycleStage(facts(FORM))).toBe("mql");
    });
    it("mql time is the earliest submission; none gives null", () => {
      const later = new Date("2025-04-01T00:00:00Z");
      expect(mqlOccurredAt([later, FORM, later])).toEqual(FORM);
      expect(mqlOccurredAt([])).toBeNull();
    });
  });

  describe("mql → sql: an opportunity at qualification", () => {
    it("prospecting alone changes nothing", () => {
      expect(lifecycleStage(facts(FORM, opp("prospecting")))).toBe("mql");
      expect(lifecycleStage(facts(null, opp("prospecting")))).toBe("lead");
    });
    it("qualification: sql", () => {
      expect(lifecycleStage(facts(FORM, opp("qualification")))).toBe("sql");
    });
    it("a CRM-only contact reaches sql without being an mql", () => {
      expect(lifecycleStage(facts(null, opp("qualification")))).toBe("sql");
    });
  });

  describe("sql → opportunity: an opportunity at proposal or later", () => {
    it.each(["proposal", "negotiation"])("%s: opportunity", (stage) => {
      expect(lifecycleStage(facts(FORM, opp(stage)))).toBe("opportunity");
    });
    it("closed_won without won = true is still an opportunity, not won", () => {
      expect(lifecycleStage(facts(FORM, opp("closed_won", false)))).toBe("opportunity");
    });
  });

  describe("opportunity → won: closed_won with won = true", () => {
    it("closed_won, won = true: won", () => {
      expect(lifecycleStage(facts(FORM, opp("closed_won", true)))).toBe("won");
    });
    it("won = true on a stage other than closed_won does not make a win", () => {
      expect(lifecycleStage(facts(FORM, opp("negotiation", true)))).toBe("opportunity");
    });
  });

  describe("closed_lost and unknown stages prove nothing", () => {
    it("closed_lost leaves the stage at what the form gave", () => {
      expect(lifecycleStage(facts(FORM, opp("closed_lost")))).toBe("mql");
      expect(lifecycleStage(facts(null, opp("closed_lost")))).toBe("lead");
    });
    it("an unknown stage name proves nothing", () => {
      expect(lifecycleStage(facts(FORM, opp("mystery")))).toBe("mql");
    });
  });

  describe("several opportunities", () => {
    it("the furthest one counts, in any order", () => {
      const a = [opp("qualification"), opp("negotiation"), opp("closed_lost")];
      expect(lifecycleStage(facts(FORM, ...a))).toBe("opportunity");
      expect(lifecycleStage(facts(FORM, ...a.reverse()))).toBe("opportunity");
    });
    it("a win beats an open or lost deal", () => {
      expect(
        lifecycleStage(facts(FORM, opp("closed_lost"), opp("closed_won", true), opp("proposal"))),
      ).toBe("won");
    });
    it("stage names are trimmed and lowercased, as staging does", () => {
      expect(opportunityStageReached(opp(" Closed_Won ", true))).toBe("won");
    });
  });

  it("every CRM stage name is covered by a rule", () => {
    expect(OPPORTUNITY_STAGES.map((s) => opportunityStageReached(opp(s, true)))).toEqual([
      null,
      "sql",
      "opportunity",
      "opportunity",
      "won",
      null,
    ]);
  });
});

describe("stages only move forward", () => {
  it("same stage: unchanged", () => {
    expect(advanceStage("sql", "sql")).toEqual({ kind: "unchanged", stage: "sql" });
  });
  it("higher stage: forward, even skipping stages", () => {
    expect(advanceStage("lead", "opportunity")).toEqual({ kind: "forward", stage: "opportunity" });
  });
  it("lower stage without a reason is held at the current one", () => {
    expect(advanceStage("won", "mql")).toEqual({ kind: "held", stage: "won", wanted: "mql" });
    expect(advanceStage("won", "mql", "   ")).toEqual({
      kind: "held",
      stage: "won",
      wanted: "mql",
    });
  });
  it("lower stage with a reason moves back and returns the reason", () => {
    expect(advanceStage("won", "opportunity", " deal reopened ")).toEqual({
      kind: "backward",
      stage: "opportunity",
      reason: "deal reopened",
    });
  });
  it("a reason does not matter on a forward move", () => {
    expect(advanceStage("mql", "sql", "x").kind).toBe("forward");
  });

  it("unrecordedRegressions finds backward entries with no reason", () => {
    expect(unrecordedRegressions([])).toEqual([]);
    expect(
      unrecordedRegressions([
        { stage: "lead" },
        { stage: "sql" },
        { stage: "mql" },
        { stage: "won" },
        { stage: "sql", reason: "deal reopened" },
        { stage: "mql", reason: " " },
      ]),
    ).toEqual([2, 5]);
  });
});

describe("every won profile has an opportunity with won = true", () => {
  it("passes when lifecycleStage decides the stage", () => {
    const rows = [
      { profileId: "p1", opportunities: [opp("closed_won", true)] },
      { profileId: "p2", opportunities: [opp("closed_won", false), opp("closed_lost")] },
      { profileId: "p3", opportunities: [] },
    ].map((r) => ({ ...r, stage: lifecycleStage(facts(FORM, ...r.opportunities)) }));
    expect(rows.map((r) => r.stage)).toEqual(["won", "opportunity", "mql"]);
    expect(wonWithoutWonOpportunity(rows)).toEqual([]);
  });
  it("reports a won profile with no won opportunity", () => {
    expect(
      wonWithoutWonOpportunity([
        { profileId: "bad", stage: "won", opportunities: [opp("closed_won", false)] },
        { profileId: "none", stage: "won", opportunities: [] },
        { profileId: "ok", stage: "won", opportunities: [opp("closed_won", true)] },
        { profileId: "open", stage: "sql", opportunities: [] },
      ]),
    ).toEqual(["bad", "none"]);
  });
});
