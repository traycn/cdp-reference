import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backwardMoves, checkRows, snapshot } from "../src/checks.ts";
import { materialize } from "../src/materialize.ts";
import { createTestDb, type TestDb } from "./db.ts";

let testDb: TestDb | null = null;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb?.drop();
});

/**
 * Profiles (anchor → what they hold):
 *  lead     no form, no opportunity
 *  mql      two forms (the earlier one counts)
 *  sql      one form, opportunity at qualification
 *  opp      opportunity at proposal, plus a lost one
 *  won      closed_won twice (two won conversions) and a prospecting one
 *  crmonly  no form, opportunity at qualification (SQL without ever being an MQL)
 *  fake     closed_won but won = false (Opportunity, not Won)
 */
async function seed(c: pg.Client): Promise<void> {
  const profile = (anchor: string) =>
    c.query(
      "INSERT INTO core.customer_profile (profile_id, anchor_key) VALUES (core.profile_uuid($1), $1)",
      [anchor],
    );
  const link = (anchor: string, type: string, value: string) =>
    c.query(
      `INSERT INTO core.identity_link (profile_id, id_type, id_value, source, confidence)
       VALUES (core.profile_uuid($1), $2, $3, 'test', 1)`,
      [anchor, type, value],
    );
  const form = async (anchor: string, id: string, at: string) => {
    await c.query(
      `INSERT INTO raw.web_event (source_event_id, occurred_at, anonymous_id, event_name, batch_id)
       VALUES ($1, $2, 'a', 'form_submit', 't')`,
      [id, at],
    );
    await link(anchor, "form_submission", id);
  };
  const opp = async (
    anchor: string,
    id: string,
    stage: string,
    won: boolean | null,
    amount: string | null,
    closed: string | null,
  ) => {
    await c.query(
      `INSERT INTO raw.crm_opportunity (opp_id, crm_id, stage, amount, opened_at, closed_at, won, batch_id)
       VALUES ($1, 'x', $2, $3, '2025-01-01Z', $4, $5, 't')`,
      [id, stage, amount, closed, won],
    );
    await link(anchor, "opp_id", id);
  };
  for (const a of [
    "crm:lead",
    "crm:mql",
    "crm:sql",
    "crm:opp",
    "crm:won",
    "crm:crmonly",
    "crm:fake",
  ])
    await profile(a);
  await form("crm:mql", "F2", "2025-02-02T10:00:00Z");
  await form("crm:mql", "F1", "2025-02-01T10:00:00Z");
  await form("crm:sql", "F3", "2025-02-03T10:00:00Z");
  await form("crm:opp", "F4", "2025-02-04T10:00:00Z");
  await form("crm:won", "F5", "2025-02-05T10:00:00Z");
  await form("crm:fake", "F6", "2025-02-06T10:00:00Z");
  await opp("crm:sql", "O1", "qualification", null, "100.00", null);
  await opp("crm:opp", "O2", "proposal", null, "200.00", null);
  await opp("crm:opp", "O3", "closed_lost", false, "300.00", "2025-03-01T00:00:00Z");
  await opp("crm:won", "O4", "closed_won", true, "1200.50", "2025-03-05T12:00:00Z");
  await opp("crm:won", "O5", "closed_won", true, "800.00", "2025-04-05T12:00:00Z");
  await opp("crm:won", "O6", "prospecting", null, "50.00", null);
  await opp("crm:crmonly", "O7", "qualification", null, "10.00", null);
  await opp("crm:fake", "O8", "closed_won", false, "900.00", "2025-03-10T00:00:00Z");
}

async function reset(c: pg.Client): Promise<void> {
  await c.query(
    "TRUNCATE core.conversion, core.lifecycle_history, core.identity_link, core.customer_profile, " +
      "raw.web_event, raw.crm_opportunity CASCADE",
  );
}

const stageOf = async (c: pg.Client, anchor: string) =>
  (
    await c.query<{ s: string }>(
      "SELECT lifecycle_stage AS s FROM core.customer_profile WHERE anchor_key = $1",
      [anchor],
    )
  ).rows[0]!.s;

describe("materialize on database rows", () => {
  let c: pg.Client;
  beforeEach(async (ctx) => {
    if (testDb === null) return ctx.skip();
    c = testDb.client;
    await reset(c);
    await seed(c);
  });

  it("writes each profile's stage and history", async () => {
    const r = await materialize(c, { newDataset: true });
    expect(r.stageCounts).toEqual({ lead: 1, mql: 1, sql: 2, opportunity: 2, won: 1 });
    expect(await stageOf(c, "crm:crmonly")).toBe("sql");
    expect(await stageOf(c, "crm:fake")).toBe("opportunity");
    const { rows } = await c.query("SELECT count(*), max(seq) FROM core.lifecycle_history");
    expect(rows[0]).toEqual({ count: "7", max: 1 });
  });

  it("writes mql at the first form fill and won at closed_at with the amount", async () => {
    const r = await materialize(c, { newDataset: true });
    expect([r.mqlConversions, r.wonConversions]).toEqual([5, 2]);
    const { rows } = await c.query(
      `SELECT conversion_id, kind, occurred_at::text AS at, revenue::text AS revenue, source_id
       FROM core.conversion WHERE conversion_id LIKE 'won:%' OR profile_id = core.profile_uuid('crm:mql')
       ORDER BY conversion_id`,
    );
    expect(rows.map((x) => [x.kind, x.at, x.revenue, x.source_id])).toEqual([
      ["mql", "2025-02-01 10:00:00+00", "0.00", null],
      ["won", "2025-03-05 12:00:00+00", "1200.50", "O4"],
      ["won", "2025-04-05 12:00:00+00", "800.00", "O5"],
    ]);
  });

  it("a won opportunity with no closed_at is counted, not written", async () => {
    await c.query("UPDATE raw.crm_opportunity SET closed_at = NULL WHERE opp_id = 'O5'");
    const r = await materialize(c, { newDataset: true });
    expect([r.wonConversions, r.wonWithoutClosedAt]).toEqual([1, 1]);
  });

  it("re-running changes no counts and no hashes", async () => {
    await materialize(c, { newDataset: true });
    const first = await snapshot(c);
    const again = await materialize(c);
    expect(again.changes).toEqual({ history: 0, stages: 0, conversions: 0, conversionsDeleted: 0 });
    expect(await snapshot(c)).toEqual(first);
    expect(first.counts).toEqual({ profiles: 7, conversions: 7, history: 7 });
  });

  it("the row rules hold after a run", async () => {
    await materialize(c, { newDataset: true });
    expect(await checkRows(c)).toEqual([]);
    expect(await backwardMoves(c)).toBe(0);
  });

  it("stages move forward when facts do, and history keeps both", async () => {
    await materialize(c, { newDataset: true });
    await c.query("UPDATE raw.crm_opportunity SET stage = 'negotiation' WHERE opp_id = 'O1'");
    const r = await materialize(c);
    expect(r.changes.history).toBe(1);
    expect(await stageOf(c, "crm:sql")).toBe("opportunity");
    const { rows } = await c.query(
      "SELECT seq, stage FROM core.lifecycle_history WHERE profile_id = core.profile_uuid('crm:sql') ORDER BY seq",
    );
    expect(rows).toEqual([
      { seq: 1, stage: "sql" },
      { seq: 2, stage: "opportunity" },
    ]);
  });

  it("lower facts do not lower the stage; the attempt is held, and the row check sees it", async () => {
    await materialize(c, { newDataset: true });
    await c.query("UPDATE raw.crm_opportunity SET won = false WHERE opp_id IN ('O4', 'O5')");
    const r = await materialize(c);
    expect(r.held).toBe(1);
    expect(await stageOf(c, "crm:won")).toBe("won");
    const rules = (await checkRows(c)).map((v) => v.rule);
    expect(rules).toContain("every Won profile has an opportunity with won = true");
  });

  it("a new dataset starts every profile again from its facts", async () => {
    await materialize(c, { newDataset: true });
    await c.query("UPDATE raw.crm_opportunity SET won = false WHERE opp_id IN ('O4', 'O5')");
    const r = await materialize(c, { newDataset: true });
    expect(r.held).toBe(0);
    expect(await stageOf(c, "crm:won")).toBe("opportunity");
    expect(await checkRows(c)).toEqual([]);
  });

  it("drops conversions that no longer hold", async () => {
    await materialize(c, { newDataset: true });
    await c.query("DELETE FROM core.identity_link WHERE id_value = 'F3'");
    const r = await materialize(c, { newDataset: true });
    expect(r.changes.conversionsDeleted).toBe(1);
    expect((await snapshot(c)).counts.conversions).toBe(6);
  });
});

describe("the history table", () => {
  let c: pg.Client;
  beforeEach(async (ctx) => {
    if (testDb === null) return ctx.skip();
    c = testDb.client;
    await reset(c);
    await seed(c);
    await materialize(c, { newDataset: true });
  });

  const wonProfile = "core.profile_uuid('crm:won')";
  const insert = (seq: number, stage: string, reason: string | null) =>
    c.query(
      `INSERT INTO core.lifecycle_history (profile_id, seq, stage, reason)
       VALUES (${wonProfile}, $1, $2, $3)`,
      [seq, stage, reason],
    );

  it("refuses a backward row without a reason", async () => {
    await expect(insert(2, "mql", null)).rejects.toThrow(/without a reason/);
  });

  it("refuses a blank reason", async () => {
    await expect(insert(2, "mql", "  ")).rejects.toThrow();
  });

  it("accepts a backward row with a reason, and the report counts it", async () => {
    await insert(2, "opportunity", "deal reopened");
    expect(await backwardMoves(c)).toBe(1);
    const rules = (await checkRows(c)).map((v) => v.rule);
    expect(rules).not.toContain("no stage moves backward without a recorded reason");
  });

  it("the row check finds an unrecorded backward row if the trigger is bypassed", async () => {
    await c.query(
      "ALTER TABLE core.lifecycle_history DISABLE TRIGGER lifecycle_history_forward_only",
    );
    await insert(2, "mql", null);
    await c.query(
      "ALTER TABLE core.lifecycle_history ENABLE TRIGGER lifecycle_history_forward_only",
    );
    const violation = (await checkRows(c)).find((v) =>
      v.rule.startsWith("no stage moves backward"),
    );
    expect(violation?.count).toBe(1);
  });
});
