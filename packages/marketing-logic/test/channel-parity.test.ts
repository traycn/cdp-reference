/**
 * Runs the shared case table (channel-cases.ts) through definitions.ts and through the staging
 * SQL, in a throwaway database made from db/migrations. Both must give the expected channel,
 * so they cannot differ from each other either. Without a reachable Postgres the test is
 * skipped; with CI set, it fails instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adClickChannel, channelFor, sessionChannels } from "../src/definitions.ts";
import { AD_CLICK_CASES, CHANNEL_CASES } from "./channel-cases.ts";

const MIGRATIONS = join(fileURLToPath(import.meta.url), "../../../../db/migrations");
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://cdp:cdp_local_only@localhost:5432/cdp";
const BASE = Date.parse("2025-03-01T00:00:00Z");

let db: pg.Client | null = null;
let drop: (() => Promise<void>) | null = null;
let unavailable = "";

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    if (process.env["CI"]) throw error;
    unavailable = String(error);
    return;
  }
  const name = `cdp_parity_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const up = readFileSync(join(MIGRATIONS, file), "utf8").split("-- migrate:down")[0]!;
    await db.query(up);
  }
  drop = async () => {
    await db?.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  };
});

afterAll(async () => {
  await drop?.();
});

function ready(): pg.Client {
  if (db === null) throw new Error(`no Postgres: ${unavailable}`);
  return db;
}

const pad = (n: number) => String(n).padStart(3, "0");

describe("channel parity: definitions.ts and the staging SQL", () => {
  it("every single-event case: staging.channel_for", async (ctx) => {
    if (db === null) return ctx.skip();
    for (const c of CHANNEL_CASES.filter((c) => !c.session)) {
      const e = c.events[0]!;
      const { rows } = await ready().query<{ channel: string }>(
        "SELECT staging.channel_for($1::text, $2::text, $3::text) AS channel",
        [e.source ?? null, e.medium ?? null, e.referrer ?? null],
      );
      const ts = channelFor({ utmSource: e.source, utmMedium: e.medium, referrer: e.referrer });
      expect({ case: c.name, sql: rows[0]!.channel, ts }).toEqual({
        case: c.name,
        sql: c.expected[0],
        ts: c.expected[0],
      });
    }
  });

  it("every case as web events: staging.web_event.channel", async (ctx) => {
    if (db === null) return ctx.skip();
    const client = ready();
    const tsChannels = new Map<string, string>();
    CHANNEL_CASES.forEach((c, i) => {
      const events = c.events.map((e, j) => ({
        id: `c${pad(i)}e${pad(j)}`,
        occurredAt: new Date(BASE + i * 3_600_000 + j * 1000),
        sessionId: c.session ? `s${pad(i)}` : null,
        utmSource: e.source,
        utmMedium: e.medium,
        referrer: e.referrer,
      }));
      for (const [id, channel] of sessionChannels(events)) tsChannels.set(id, channel);
    });
    for (const [i, c] of CHANNEL_CASES.entries()) {
      for (const [j, e] of c.events.entries()) {
        await client.query(
          `INSERT INTO raw.web_event (source_event_id, occurred_at, anonymous_id, event_name,
             referrer, utm_source, utm_medium, properties, batch_id)
           VALUES ($1, $2, $3, 'page_view', $4, $5, $6, $7::jsonb, 'parity')`,
          [
            `c${pad(i)}e${pad(j)}`,
            new Date(BASE + i * 3_600_000 + j * 1000),
            `a${pad(i)}`,
            e.referrer ?? null,
            e.source ?? null,
            e.medium ?? null,
            JSON.stringify(c.session ? { session_id: `s${pad(i)}` } : {}),
          ],
        );
      }
    }
    const { rows } = await client.query<{ source_event_id: string; channel: string }>(
      "SELECT source_event_id, channel FROM staging.web_event WHERE batch_id = 'parity'",
    );
    const sql = new Map(rows.map((r) => [r.source_event_id, r.channel]));
    for (const [i, c] of CHANNEL_CASES.entries()) {
      const got = c.events.map((_, j) => sql.get(`c${pad(i)}e${pad(j)}`));
      const ts = c.events.map((_, j) => tsChannels.get(`c${pad(i)}e${pad(j)}`));
      expect({ case: c.name, sql: got, ts }).toEqual({
        case: c.name,
        sql: c.expected,
        ts: c.expected,
      });
    }
  });

  it("entry event: earliest wins even when inserted last; a tie goes to the smaller id", async (ctx) => {
    if (db === null) return ctx.skip();
    const client = ready();
    const rows = [
      // id, seconds, referrer; inserted in reverse time order
      ["tie_b", 10, "https://news.example/x"],
      ["tie_a", 10, "https://www.google.com/"],
      ["tie_late", 20, null],
    ] as const;
    for (const [id, s, referrer] of rows) {
      await client.query(
        `INSERT INTO raw.web_event (source_event_id, occurred_at, anonymous_id, event_name,
           referrer, properties, batch_id)
         VALUES ($1, $2, 'a_tie', 'page_view', $3, '{"session_id": "s_tie"}'::jsonb, 'parity')`,
        [id, new Date(BASE + s * 1000), referrer],
      );
    }
    const sql = await client.query<{ channel: string }>(
      "SELECT DISTINCT channel FROM staging.web_event WHERE properties ->> 'session_id' = 's_tie'",
    );
    const ts = sessionChannels(
      [...rows].reverse().map(([id, s, referrer]) => ({
        id,
        occurredAt: new Date(BASE + s * 1000),
        sessionId: "s_tie",
        referrer,
      })),
    );
    expect(sql.rows.map((r) => r.channel)).toEqual(["organic"]);
    expect([...ts.values()]).toEqual(["organic", "organic", "organic"]);
  });

  it("every ad click case: staging.ad_click.channel", async (ctx) => {
    if (db === null) return ctx.skip();
    const client = ready();
    for (const [i, c] of AD_CLICK_CASES.entries()) {
      await client.query(
        `INSERT INTO raw.ad_click (source_event_id, occurred_at, platform, utm_source, utm_medium, batch_id)
         VALUES ($1, $2, $3, $4, $5, 'parity')`,
        [`k${pad(i)}`, new Date(BASE), c.platform, c.source ?? null, c.medium ?? null],
      );
    }
    const { rows } = await client.query<{ source_event_id: string; channel: string }>(
      "SELECT source_event_id, channel FROM staging.ad_click WHERE batch_id = 'parity'",
    );
    const sql = new Map(rows.map((r) => [r.source_event_id, r.channel]));
    for (const [i, c] of AD_CLICK_CASES.entries()) {
      const ts = adClickChannel({ platform: c.platform, utmSource: c.source, utmMedium: c.medium });
      expect({ case: c.name, sql: sql.get(`k${pad(i)}`), ts }).toEqual({
        case: c.name,
        sql: c.expected,
        ts: c.expected,
      });
    }
  });
});
