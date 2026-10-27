/**
 * Everything the lead-score service reads from the database, unfiltered. The
 * visibility rules (what a score may see as of a time) are applied afterwards,
 * in snapshot.ts, so they can be tested without a database.
 */
import type pg from "pg";

export interface Link {
  idType: "crm_id" | "form_submission";
  idValue: string;
  profileId: string;
}

export interface Contact {
  crmId: string;
  email: string | null;
  emailVerified: boolean | null;
  title: string | null;
  updatedAt: number;
}

export interface WebEvent {
  id: string;
  device: string;
  at: number;
  kind: "page_view" | "form_submit";
  path: string | null;
  session: string | null;
}

export interface AdClick {
  id: string;
  device: string;
  at: number;
}

/** Read for the population and labels in fit and evaluate; never visible to a score. */
export interface Opportunity {
  oppId: string;
  crmId: string;
  openedAt: number;
}

export interface Dataset {
  profiles: string[];
  links: Link[];
  contacts: Contact[];
  webEvents: WebEvent[];
  adClicks: AdClick[];
  opportunities: Opportunity[];
}

export async function readDataset(client: pg.Client): Promise<Dataset> {
  const q = async <T extends pg.QueryResultRow>(sql: string): Promise<T[]> =>
    (await client.query<T>(sql)).rows;
  const ms = (d: Date): number => d.getTime();

  const profiles = await q<{ profile_id: string }>(
    "SELECT profile_id::text FROM core.customer_profile ORDER BY 1",
  );
  const links = await q<{ id_type: Link["idType"]; id_value: string; profile_id: string }>(
    `SELECT id_type, id_value, profile_id::text FROM core.identity_link
     WHERE id_type IN ('crm_id', 'form_submission') ORDER BY id_type, id_value`,
  );
  const contacts = await q<{
    crm_id: string;
    email: string | null;
    email_verified: boolean | null;
    title: string | null;
    updated_at: Date;
  }>(
    `SELECT crm_id, email, email_verified, title, updated_at FROM staging.crm_contact
     ORDER BY crm_id`,
  );
  const events = await q<{
    source_event_id: string;
    anonymous_id: string;
    occurred_at: Date;
    event_name: WebEvent["kind"];
    page_path: string | null;
    session_id: string | null;
  }>(
    `SELECT source_event_id, anonymous_id, occurred_at, event_name, page_path,
            properties->>'session_id' AS session_id
     FROM staging.web_event ORDER BY source_event_id`,
  );
  const clicks = await q<{ source_event_id: string; anonymous_id: string; occurred_at: Date }>(
    `SELECT source_event_id, anonymous_id, occurred_at FROM staging.ad_click
     WHERE anonymous_id IS NOT NULL ORDER BY source_event_id`,
  );
  const opps = await q<{ opp_id: string; crm_id: string; opened_at: Date }>(
    "SELECT opp_id, crm_id, opened_at FROM staging.crm_opportunity ORDER BY opp_id",
  );
  return {
    profiles: profiles.map((r) => r.profile_id),
    links: links.map((r) => ({ idType: r.id_type, idValue: r.id_value, profileId: r.profile_id })),
    contacts: contacts.map((r) => ({
      crmId: r.crm_id,
      email: r.email,
      emailVerified: r.email_verified,
      title: r.title,
      updatedAt: ms(r.updated_at),
    })),
    webEvents: events.map((r) => ({
      id: r.source_event_id,
      device: r.anonymous_id,
      at: ms(r.occurred_at),
      kind: r.event_name,
      path: r.page_path,
      session: r.session_id,
    })),
    adClicks: clicks.map((r) => ({
      id: r.source_event_id,
      device: r.anonymous_id,
      at: ms(r.occurred_at),
    })),
    opportunities: opps.map((r) => ({
      oppId: r.opp_id,
      crmId: r.crm_id,
      openedAt: ms(r.opened_at),
    })),
  };
}

/** crm_id → profile_id. */
export function profileOfContact(d: Dataset): Map<string, string> {
  return new Map(d.links.filter((l) => l.idType === "crm_id").map((l) => [l.idValue, l.profileId]));
}
