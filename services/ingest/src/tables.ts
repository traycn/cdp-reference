/**
 * Row shapes and file layout for the generator output. Column order here is
 * the CSV column order and matches db/migrations/001_init.sql (load metadata
 * columns `loaded_at` and `batch_id` are added by the loader).
 */

export type PersonKind = "ordinary" | "multi_email" | "multi_device" | "email_changed";
export type HazardKind = "same_name_relative" | "shared_household_phone";
export type UnitType = "crm_contact" | "form_submission" | "device";

export interface CrmContactRow {
  crm_id: string;
  email: string | null;
  email_verified: boolean | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  dob: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  company: string | null;
  title: string | null;
  updated_at: string;
}

export interface CrmOpportunityRow {
  opp_id: string;
  crm_id: string;
  stage: string;
  amount: string | null;
  opened_at: string;
  closed_at: string | null;
  won: boolean | null;
}

export interface WebEventRow {
  source_event_id: string;
  occurred_at: string;
  anonymous_id: string;
  event_name: "page_view" | "form_submit";
  page_path: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  email: string | null;
  properties: Record<string, string>;
}

export interface AdClickRow {
  source_event_id: string;
  occurred_at: string;
  platform: string;
  campaign: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  click_id: string | null;
  anonymous_id: string | null;
}

export interface TruthRecordRow {
  unit_type: UnitType;
  unit_key: string;
  person_id: string;
  person_kind: PersonKind;
}

export interface TruthHazardPairRow {
  person_a: string;
  person_b: string;
  kind: HazardKind;
}

export interface Tables {
  crm_contact: CrmContactRow[];
  crm_opportunity: CrmOpportunityRow[];
  web_event: WebEventRow[];
  ad_click: AdClickRow[];
  truth_record: TruthRecordRow[];
  truth_hazard_pair: TruthHazardPairRow[];
}

export interface TableSpec<K extends keyof Tables = keyof Tables> {
  key: K;
  /** Target table in Postgres. */
  table: string;
  /** Path of the CSV inside the output directory. */
  file: string;
  columns: readonly (keyof Tables[K][number] & string)[];
  primaryKey: readonly string[];
  /** raw.* tables carry loaded_at / batch_id; eval.* tables don't. */
  loadMetadata: boolean;
}

function spec<K extends keyof Tables>(s: TableSpec<K>): TableSpec<K> {
  return s;
}

export const TABLE_SPECS = [
  spec({
    key: "crm_contact",
    table: "raw.crm_contact",
    file: "raw/crm_contact.csv",
    columns: [
      "crm_id",
      "email",
      "email_verified",
      "phone",
      "first_name",
      "last_name",
      "dob",
      "address",
      "city",
      "state",
      "zip",
      "company",
      "title",
      "updated_at",
    ],
    primaryKey: ["crm_id"],
    loadMetadata: true,
  }),
  spec({
    key: "crm_opportunity",
    table: "raw.crm_opportunity",
    file: "raw/crm_opportunity.csv",
    columns: ["opp_id", "crm_id", "stage", "amount", "opened_at", "closed_at", "won"],
    primaryKey: ["opp_id"],
    loadMetadata: true,
  }),
  spec({
    key: "web_event",
    table: "raw.web_event",
    file: "raw/web_event.csv",
    columns: [
      "source_event_id",
      "occurred_at",
      "anonymous_id",
      "event_name",
      "page_path",
      "referrer",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "email",
      "properties",
    ],
    primaryKey: ["source_event_id"],
    loadMetadata: true,
  }),
  spec({
    key: "ad_click",
    table: "raw.ad_click",
    file: "raw/ad_click.csv",
    columns: [
      "source_event_id",
      "occurred_at",
      "platform",
      "campaign",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "click_id",
      "anonymous_id",
    ],
    primaryKey: ["source_event_id"],
    loadMetadata: true,
  }),
  spec({
    key: "truth_record",
    table: "eval.truth_record",
    file: "eval/truth_record.csv",
    columns: ["unit_type", "unit_key", "person_id", "person_kind"],
    primaryKey: ["unit_type", "unit_key"],
    loadMetadata: false,
  }),
  spec({
    key: "truth_hazard_pair",
    table: "eval.truth_hazard_pair",
    file: "eval/truth_hazard_pair.csv",
    columns: ["person_a", "person_b", "kind"],
    primaryKey: ["person_a", "person_b"],
    loadMetadata: false,
  }),
] as const;
