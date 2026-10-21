-- migrate:up

-- Layers (see CLAUDE.md, Schema notes):
--   raw      as delivered by the feeds; loaders upsert on the source key
--   staging  typed, normalized views over raw
--   core     unified customer model, written by stitching / scoring
--   eval     ground truth written by the generator; never read by the app or dashboard
CREATE SCHEMA raw;
CREATE SCHEMA staging;
CREATE SCHEMA core;
CREATE SCHEMA eval;

-- uuid_generate_v5 for deterministic profile IDs.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- RAW: one table per source. Every table carries load metadata; the source key
-- is the primary key, so a rerun of a loader upserts instead of adding rows.
-- ---------------------------------------------------------------------------

CREATE TABLE raw.ad_click (
  source_event_id TEXT PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL,
  platform        TEXT NOT NULL,          -- google_ads | meta | linkedin
  campaign        TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  click_id        TEXT,
  anonymous_id    TEXT,
  loaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id        TEXT NOT NULL
);

CREATE TABLE raw.web_event (
  source_event_id TEXT PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL,
  anonymous_id    TEXT NOT NULL,
  event_name      TEXT NOT NULL,          -- page_view | form_submit | signup
  page_path       TEXT,
  referrer        TEXT,                   -- full referrer URL, NULL when none
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  email           TEXT,                   -- present on form_submit
  -- form_submit carries first_name, last_name, phone (optional) and company
  properties      JSONB NOT NULL DEFAULT '{}',
  loaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id        TEXT NOT NULL
);

CREATE TABLE raw.crm_contact (
  crm_id         TEXT PRIMARY KEY,
  email          TEXT,
  email_verified BOOLEAN,
  phone          TEXT,
  first_name     TEXT,
  last_name      TEXT,
  dob            DATE,                    -- filled for --dob-rate of contacts (default 0.30)
  address        TEXT,
  city           TEXT,
  state          TEXT,
  zip            TEXT,
  company        TEXT,
  title          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL,
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id       TEXT NOT NULL
);

CREATE TABLE raw.crm_opportunity (
  opp_id     TEXT PRIMARY KEY,
  crm_id     TEXT NOT NULL,             -- no FK: raw keeps what the CRM delivered
  stage      TEXT NOT NULL,
  amount     NUMERIC(12,2),
  opened_at  TIMESTAMPTZ NOT NULL,
  closed_at  TIMESTAMPTZ,
  won        BOOLEAN,
  loaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id   TEXT NOT NULL
);

CREATE INDEX ON raw.ad_click (anonymous_id);
CREATE INDEX ON raw.web_event (anonymous_id, occurred_at);
CREATE INDEX ON raw.crm_opportunity (crm_id);

-- ---------------------------------------------------------------------------
-- STAGING: normalization functions and views. No data is copied.
-- ---------------------------------------------------------------------------

CREATE FUNCTION staging.normalize_email(email TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN NULLIF(lower(btrim(email)), '');

-- E.164 for NANP numbers (10 digits, or 11 starting with 1) and for anything
-- already written with a leading '+'. Anything else is NULL rather than a guess.
CREATE FUNCTION staging.to_e164(phone TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN (
  SELECT CASE
    WHEN d = '' THEN NULL
    WHEN btrim(phone) LIKE '+%' AND length(d) BETWEEN 8 AND 15 THEN '+' || d
    WHEN length(d) = 10 THEN '+1' || d
    WHEN length(d) = 11 AND d LIKE '1%' THEN '+' || d
    ELSE NULL
  END
  FROM (SELECT regexp_replace(phone, '\D', '', 'g') AS d) AS digits
);

-- UTM / referrer → channel. The canonical definition lives in
-- packages/marketing-logic (M4); this function must agree with it.
-- Rules, in order:
--   1. A recognized utm_medium decides the channel.
--   2. UTM tags present but not recognized → 'unattributed'.
--   3. No tags and no referrer → 'direct'.
--   4. No tags, search-engine referrer → 'organic'; any other referrer → 'referral'.
CREATE FUNCTION staging.channel_for(utm_source TEXT, utm_medium TEXT, referrer TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN (
  SELECT CASE
    WHEN m IN ('cpc', 'ppc', 'paid_search', 'sem') THEN 'paid_search'
    WHEN m IN ('paid_social', 'paidsocial', 'social_paid', 'cpm') THEN 'paid_social'
    WHEN m IN ('email', 'e-mail', 'newsletter') THEN 'email'
    WHEN m IN ('organic', 'social', 'organic_social') THEN 'organic'
    WHEN m = 'referral' THEN 'referral'
    WHEN m IS NOT NULL OR s IS NOT NULL THEN 'unattributed'
    WHEN r IS NULL THEN 'direct'
    WHEN r ~ '^(https?://)?([a-z0-9-]+\.)*(google|bing|duckduckgo|yahoo|ecosia)\.' THEN 'organic'
    ELSE 'referral'
  END
  FROM (
    SELECT NULLIF(lower(btrim(utm_source)), '') AS s,
           NULLIF(lower(btrim(utm_medium)), '') AS m,
           NULLIF(lower(btrim(referrer)), '') AS r
  ) AS norm
);

CREATE VIEW staging.ad_click AS
SELECT
  source_event_id,
  occurred_at,
  platform,
  campaign,
  utm_source,
  utm_medium,
  utm_campaign,
  click_id,
  anonymous_id,
  -- An untagged click is still paid: fall back to the platform.
  CASE
    WHEN NULLIF(btrim(utm_source), '') IS NULL AND NULLIF(btrim(utm_medium), '') IS NULL THEN
      CASE platform
        WHEN 'google_ads' THEN 'paid_search'
        WHEN 'meta' THEN 'paid_social'
        WHEN 'linkedin' THEN 'paid_social'
        ELSE 'unattributed'
      END
    ELSE staging.channel_for(utm_source, utm_medium, NULL)
  END AS channel,
  loaded_at,
  batch_id
FROM raw.ad_click;

CREATE VIEW staging.web_event AS
SELECT
  source_event_id,
  occurred_at,
  anonymous_id,
  event_name,
  page_path,
  referrer,
  utm_source,
  utm_medium,
  utm_campaign,
  staging.channel_for(utm_source, utm_medium, referrer) AS channel,
  staging.normalize_email(email) AS email,
  properties,
  loaded_at,
  batch_id
FROM raw.web_event;

-- Form submissions as person records (01 record_id: 'form:' || source_event_id).
CREATE VIEW staging.form_submission AS
SELECT
  source_event_id,
  anonymous_id,
  occurred_at,
  staging.normalize_email(email) AS email,
  NULLIF(btrim(properties ->> 'first_name'), '') AS first_name,
  NULLIF(btrim(properties ->> 'last_name'), '') AS last_name,
  staging.to_e164(properties ->> 'phone') AS phone,
  NULLIF(btrim(properties ->> 'company'), '') AS company,
  loaded_at,
  batch_id
FROM raw.web_event
WHERE event_name = 'form_submit';

-- CRM contacts as person records (01 record_id: 'crm:' || crm_id).
CREATE VIEW staging.crm_contact AS
SELECT
  crm_id,
  staging.normalize_email(email) AS email,
  email_verified,
  staging.to_e164(phone) AS phone,
  NULLIF(btrim(first_name), '') AS first_name,
  NULLIF(btrim(last_name), '') AS last_name,
  dob,
  NULLIF(btrim(address), '') AS address,
  NULLIF(btrim(city), '') AS city,
  upper(NULLIF(btrim(state), '')) AS state,
  NULLIF(btrim(zip), '') AS zip,
  NULLIF(btrim(company), '') AS company,
  NULLIF(btrim(title), '') AS title,
  updated_at,
  loaded_at,
  batch_id
FROM raw.crm_contact;

CREATE VIEW staging.crm_opportunity AS
SELECT
  opp_id,
  crm_id,
  lower(btrim(stage)) AS stage,
  amount,
  opened_at,
  closed_at,
  COALESCE(won, false) AS won,
  loaded_at,
  batch_id
FROM raw.crm_opportunity;

-- ---------------------------------------------------------------------------
-- CORE: unified model. Stitching rebuilds it; IDs are deterministic, so a
-- rebuild gives the same profile_id for the same input.
-- ---------------------------------------------------------------------------

-- profile_id = UUIDv5(fixed namespace, anchor_key). anchor_key is the smallest
-- member record key of the cluster in byte order (COLLATE "C"), e.g. 'crm:C000123'.
-- The stitcher may compute it in Python (uuid.uuid5 with the same namespace);
-- the CHECK on core.customer_profile keeps both in agreement.
CREATE FUNCTION core.profile_uuid(anchor_key TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN public.uuid_generate_v5('c7e7f593-bcaa-4087-a2df-d871d88ac373'::uuid, anchor_key);

CREATE TABLE core.customer_profile (
  profile_id      UUID PRIMARY KEY,
  anchor_key      TEXT NOT NULL UNIQUE CHECK (anchor_key ~ '^(crm|form):.+'),
  primary_email   TEXT,
  primary_phone   TEXT,
  full_name       TEXT,
  company         TEXT,
  lifecycle_stage TEXT NOT NULL DEFAULT 'lead'
    CHECK (lifecycle_stage IN ('lead', 'mql', 'sql', 'opportunity', 'won')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profile_id_is_uuidv5_of_anchor CHECK (profile_id = core.profile_uuid(anchor_key))
);

-- (id_type, id_value) is not the key: a shared household phone legitimately
-- belongs to two profiles. Units that belong to exactly one person are unique
-- through the partial index below.
CREATE TABLE core.identity_link (
  profile_id  UUID NOT NULL REFERENCES core.customer_profile (profile_id) ON DELETE CASCADE,
  id_type     TEXT NOT NULL
    CHECK (id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'email', 'phone')),
  id_value    TEXT NOT NULL,
  source      TEXT NOT NULL,              -- resolver | structural | device
  confidence  NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, id_type, id_value)
);

CREATE UNIQUE INDEX identity_link_unit_unique
  ON core.identity_link (id_type, id_value)
  WHERE id_type IN ('crm_id', 'form_submission', 'anonymous_id');

-- Every pair decision from 01, so a profile can be explained like 01's merges.
-- decision: 01's MATCH | REVIEW | NO_MATCH, plus SPLIT for a MATCH edge that
-- conflict-aware clustering rejected to keep conflicting records apart.
CREATE TABLE core.link_evidence (
  run_id         TEXT NOT NULL,
  left_key       TEXT NOT NULL,
  right_key      TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('MATCH', 'REVIEW', 'NO_MATCH', 'SPLIT')),
  rule           TEXT NOT NULL,
  score          DOUBLE PRECISION,
  field_scores   JSONB NOT NULL DEFAULT '{}',
  engine         TEXT NOT NULL,           -- e.g. entity-resolution
  engine_version TEXT NOT NULL,           -- the pinned 01 tag, e.g. v1.0.0
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, left_key, right_key),
  CHECK (left_key < right_key COLLATE "C")
);

CREATE INDEX ON core.link_evidence (left_key);
CREATE INDEX ON core.link_evidence (right_key);

CREATE TABLE core.touchpoint (
  touchpoint_id BIGSERIAL PRIMARY KEY,
  profile_id    UUID NOT NULL REFERENCES core.customer_profile (profile_id) ON DELETE CASCADE,
  occurred_at   TIMESTAMPTZ NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN (
                  'paid_search', 'paid_social', 'organic', 'email',
                  'referral', 'direct', 'unattributed')),
  source_table  TEXT NOT NULL,            -- raw.ad_click | raw.web_event
  source_id     TEXT NOT NULL,
  UNIQUE (source_table, source_id)
);

CREATE INDEX ON core.touchpoint (profile_id, occurred_at);

-- kind = 'won': one row per won opportunity; occurred_at = closed_at, revenue = amount,
--               source_id = opp_id.
-- kind = 'mql': one row per profile reaching MQL; occurred_at = when the criterion
--               was first met, revenue = 0.
CREATE TABLE core.conversion (
  conversion_id TEXT PRIMARY KEY,
  profile_id    UUID NOT NULL REFERENCES core.customer_profile (profile_id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('won', 'mql')),
  occurred_at   TIMESTAMPTZ NOT NULL,
  revenue       NUMERIC(12,2) NOT NULL CHECK (revenue >= 0),
  source_id     TEXT,
  CHECK (kind <> 'mql' OR revenue = 0),
  CHECK (kind <> 'won' OR source_id IS NOT NULL)
);

CREATE UNIQUE INDEX conversion_won_once ON core.conversion (source_id) WHERE kind = 'won';
CREATE UNIQUE INDEX conversion_mql_once ON core.conversion (profile_id) WHERE kind = 'mql';
CREATE INDEX ON core.conversion (profile_id, occurred_at);

CREATE TABLE core.lead_score (
  profile_id       UUID PRIMARY KEY REFERENCES core.customer_profile (profile_id) ON DELETE CASCADE,
  fit_score        INT NOT NULL,
  engagement_score INT NOT NULL,
  total_score      INT GENERATED ALWAYS AS (fit_score + engagement_score) STORED,
  scored_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- EVAL: ground truth (docs/acceptance.md, Ground truth). Written by the
-- generator only.
-- ---------------------------------------------------------------------------

CREATE TABLE eval.truth_record (
  unit_type   TEXT NOT NULL CHECK (unit_type IN ('crm_contact', 'form_submission', 'device')),
  unit_key    TEXT NOT NULL,              -- crm_id | form source_event_id | anonymous_id
  person_id   TEXT NOT NULL,
  person_kind TEXT NOT NULL
    CHECK (person_kind IN ('ordinary', 'multi_email', 'multi_device', 'email_changed')),
  PRIMARY KEY (unit_type, unit_key)
);

CREATE INDEX ON eval.truth_record (person_id);

CREATE TABLE eval.truth_hazard_pair (
  person_a TEXT NOT NULL,
  person_b TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('same_name_relative', 'shared_household_phone')),
  PRIMARY KEY (person_a, person_b),
  CHECK (person_a < person_b COLLATE "C")
);

-- migrate:down
DROP SCHEMA eval CASCADE;
DROP SCHEMA core CASCADE;
DROP SCHEMA staging CASCADE;
DROP SCHEMA raw CASCADE;
DROP EXTENSION IF EXISTS "uuid-ossp";
