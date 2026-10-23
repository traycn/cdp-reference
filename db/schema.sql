\restrict dbmate

-- Dumped from database version 16.15 (Debian 16.15-1.pgdg13+2)
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: eval; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA eval;


--
-- Name: raw; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA raw;


--
-- Name: staging; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA staging;


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: profile_uuid(text); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.profile_uuid(anchor_key text) RETURNS uuid
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN public.uuid_generate_v5('c7e7f593-bcaa-4087-a2df-d871d88ac373'::uuid, anchor_key);


--
-- Name: channel_for(text, text, text); Type: FUNCTION; Schema: staging; Owner: -
--

CREATE FUNCTION staging.channel_for(utm_source text, utm_medium text, referrer text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN (SELECT CASE WHEN (norm.m = ANY (ARRAY['cpc'::text, 'ppc'::text, 'paid_search'::text, 'sem'::text])) THEN 'paid_search'::text WHEN (norm.m = ANY (ARRAY['paid_social'::text, 'paidsocial'::text, 'social_paid'::text, 'cpm'::text])) THEN 'paid_social'::text WHEN (norm.m = ANY (ARRAY['email'::text, 'e-mail'::text, 'newsletter'::text])) THEN 'email'::text WHEN (norm.m = ANY (ARRAY['organic'::text, 'social'::text, 'organic_social'::text])) THEN 'organic'::text WHEN (norm.m = 'referral'::text) THEN 'referral'::text WHEN ((norm.m IS NOT NULL) OR (norm.s IS NOT NULL)) THEN 'unattributed'::text WHEN (norm.r IS NULL) THEN 'direct'::text WHEN (norm.r ~ '^(https?://)?([a-z0-9-]+\.)*(google|bing|duckduckgo|yahoo|ecosia)\.'::text) THEN 'organic'::text ELSE 'referral'::text END AS "case" FROM (SELECT NULLIF(lower(btrim(channel_for.utm_source)), ''::text) AS s, NULLIF(lower(btrim(channel_for.utm_medium)), ''::text) AS m, NULLIF(lower(btrim(channel_for.referrer)), ''::text) AS r) norm);


--
-- Name: normalize_email(text); Type: FUNCTION; Schema: staging; Owner: -
--

CREATE FUNCTION staging.normalize_email(email text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN NULLIF(lower(btrim(email)), ''::text);


--
-- Name: to_e164(text); Type: FUNCTION; Schema: staging; Owner: -
--

CREATE FUNCTION staging.to_e164(phone text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN (SELECT CASE WHEN (digits.d = ''::text) THEN NULL::text WHEN ((btrim(to_e164.phone) ~~ '+%'::text) AND ((length(digits.d) >= 8) AND (length(digits.d) <= 15))) THEN ('+'::text || digits.d) WHEN (length(digits.d) = 10) THEN ('+1'::text || digits.d) WHEN ((length(digits.d) = 11) AND (digits.d ~~ '1%'::text)) THEN ('+'::text || digits.d) ELSE NULL::text END AS "case" FROM (SELECT regexp_replace(to_e164.phone, '\D'::text, ''::text, 'g'::text) AS d) digits);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: conversion; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.conversion (
    conversion_id text NOT NULL,
    profile_id uuid NOT NULL,
    kind text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    revenue numeric(12,2) NOT NULL,
    source_id text,
    CONSTRAINT conversion_check CHECK (((kind <> 'mql'::text) OR (revenue = (0)::numeric))),
    CONSTRAINT conversion_check1 CHECK (((kind <> 'won'::text) OR (source_id IS NOT NULL))),
    CONSTRAINT conversion_kind_check CHECK ((kind = ANY (ARRAY['won'::text, 'mql'::text]))),
    CONSTRAINT conversion_revenue_check CHECK ((revenue >= (0)::numeric))
);


--
-- Name: customer_profile; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.customer_profile (
    profile_id uuid NOT NULL,
    anchor_key text NOT NULL,
    primary_email text,
    primary_phone text,
    full_name text,
    company text,
    lifecycle_stage text DEFAULT 'lead'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_profile_anchor_key_check CHECK ((anchor_key ~ '^(crm|form):.+'::text)),
    CONSTRAINT customer_profile_lifecycle_stage_check CHECK ((lifecycle_stage = ANY (ARRAY['lead'::text, 'mql'::text, 'sql'::text, 'opportunity'::text, 'won'::text]))),
    CONSTRAINT profile_id_is_uuidv5_of_anchor CHECK ((profile_id = core.profile_uuid(anchor_key)))
);


--
-- Name: identity_link; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.identity_link (
    profile_id uuid NOT NULL,
    id_type text NOT NULL,
    id_value text NOT NULL,
    source text NOT NULL,
    confidence numeric(4,3) NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_link_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT identity_link_id_type_check CHECK ((id_type = ANY (ARRAY['crm_id'::text, 'form_submission'::text, 'anonymous_id'::text, 'opp_id'::text, 'email'::text, 'phone'::text])))
);


--
-- Name: lead_score; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.lead_score (
    profile_id uuid NOT NULL,
    fit_score integer NOT NULL,
    engagement_score integer NOT NULL,
    total_score integer GENERATED ALWAYS AS ((fit_score + engagement_score)) STORED,
    scored_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: link_evidence; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.link_evidence (
    run_id text NOT NULL,
    left_key text NOT NULL,
    right_key text NOT NULL,
    decision text NOT NULL,
    rule text NOT NULL,
    score double precision,
    field_scores jsonb DEFAULT '{}'::jsonb NOT NULL,
    engine text NOT NULL,
    engine_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT link_evidence_check CHECK ((left_key < (right_key COLLATE "C"))),
    CONSTRAINT link_evidence_decision_check CHECK ((decision = ANY (ARRAY['MATCH'::text, 'REVIEW'::text, 'NO_MATCH'::text, 'SPLIT'::text])))
);


--
-- Name: touchpoint; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.touchpoint (
    touchpoint_id bigint NOT NULL,
    profile_id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    channel text NOT NULL,
    source_table text NOT NULL,
    source_id text NOT NULL,
    CONSTRAINT touchpoint_channel_check CHECK ((channel = ANY (ARRAY['paid_search'::text, 'paid_social'::text, 'organic'::text, 'email'::text, 'referral'::text, 'direct'::text, 'unattributed'::text])))
);


--
-- Name: touchpoint_touchpoint_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.touchpoint_touchpoint_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: touchpoint_touchpoint_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.touchpoint_touchpoint_id_seq OWNED BY core.touchpoint.touchpoint_id;


--
-- Name: truth_hazard_pair; Type: TABLE; Schema: eval; Owner: -
--

CREATE TABLE eval.truth_hazard_pair (
    person_a text NOT NULL,
    person_b text NOT NULL,
    kind text NOT NULL,
    CONSTRAINT truth_hazard_pair_check CHECK ((person_a < (person_b COLLATE "C"))),
    CONSTRAINT truth_hazard_pair_kind_check CHECK ((kind = ANY (ARRAY['same_name_relative'::text, 'shared_household_phone'::text])))
);


--
-- Name: truth_record; Type: TABLE; Schema: eval; Owner: -
--

CREATE TABLE eval.truth_record (
    unit_type text NOT NULL,
    unit_key text NOT NULL,
    person_id text NOT NULL,
    person_kind text NOT NULL,
    CONSTRAINT truth_record_person_kind_check CHECK ((person_kind = ANY (ARRAY['ordinary'::text, 'multi_email'::text, 'multi_device'::text, 'email_changed'::text]))),
    CONSTRAINT truth_record_unit_type_check CHECK ((unit_type = ANY (ARRAY['crm_contact'::text, 'form_submission'::text, 'device'::text])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: ad_click; Type: TABLE; Schema: raw; Owner: -
--

CREATE TABLE raw.ad_click (
    source_event_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    platform text NOT NULL,
    campaign text,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    click_id text,
    anonymous_id text,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id text NOT NULL
);


--
-- Name: crm_contact; Type: TABLE; Schema: raw; Owner: -
--

CREATE TABLE raw.crm_contact (
    crm_id text NOT NULL,
    email text,
    email_verified boolean,
    phone text,
    first_name text,
    last_name text,
    dob date,
    address text,
    city text,
    state text,
    zip text,
    company text,
    title text,
    updated_at timestamp with time zone NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id text NOT NULL
);


--
-- Name: crm_opportunity; Type: TABLE; Schema: raw; Owner: -
--

CREATE TABLE raw.crm_opportunity (
    opp_id text NOT NULL,
    crm_id text NOT NULL,
    stage text NOT NULL,
    amount numeric(12,2),
    opened_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    won boolean,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id text NOT NULL
);


--
-- Name: web_event; Type: TABLE; Schema: raw; Owner: -
--

CREATE TABLE raw.web_event (
    source_event_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    anonymous_id text NOT NULL,
    event_name text NOT NULL,
    page_path text,
    referrer text,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    email text,
    properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL,
    batch_id text NOT NULL
);


--
-- Name: ad_click; Type: VIEW; Schema: staging; Owner: -
--

CREATE VIEW staging.ad_click AS
 SELECT source_event_id,
    occurred_at,
    platform,
    campaign,
    utm_source,
    utm_medium,
    utm_campaign,
    click_id,
    anonymous_id,
        CASE
            WHEN ((NULLIF(btrim(utm_source), ''::text) IS NULL) AND (NULLIF(btrim(utm_medium), ''::text) IS NULL)) THEN
            CASE platform
                WHEN 'google_ads'::text THEN 'paid_search'::text
                WHEN 'meta'::text THEN 'paid_social'::text
                WHEN 'linkedin'::text THEN 'paid_social'::text
                ELSE 'unattributed'::text
            END
            ELSE staging.channel_for(utm_source, utm_medium, NULL::text)
        END AS channel,
    loaded_at,
    batch_id
   FROM raw.ad_click;


--
-- Name: crm_contact; Type: VIEW; Schema: staging; Owner: -
--

CREATE VIEW staging.crm_contact AS
 SELECT crm_id,
    staging.normalize_email(email) AS email,
    email_verified,
    staging.to_e164(phone) AS phone,
    NULLIF(btrim(first_name), ''::text) AS first_name,
    NULLIF(btrim(last_name), ''::text) AS last_name,
    dob,
    NULLIF(btrim(address), ''::text) AS address,
    NULLIF(btrim(city), ''::text) AS city,
    upper(NULLIF(btrim(state), ''::text)) AS state,
    NULLIF(btrim(zip), ''::text) AS zip,
    NULLIF(btrim(company), ''::text) AS company,
    NULLIF(btrim(title), ''::text) AS title,
    updated_at,
    loaded_at,
    batch_id
   FROM raw.crm_contact;


--
-- Name: crm_opportunity; Type: VIEW; Schema: staging; Owner: -
--

CREATE VIEW staging.crm_opportunity AS
 SELECT opp_id,
    crm_id,
    lower(btrim(stage)) AS stage,
    amount,
    opened_at,
    closed_at,
    COALESCE(won, false) AS won,
    loaded_at,
    batch_id
   FROM raw.crm_opportunity;


--
-- Name: form_submission; Type: VIEW; Schema: staging; Owner: -
--

CREATE VIEW staging.form_submission AS
 SELECT source_event_id,
    anonymous_id,
    occurred_at,
    staging.normalize_email(email) AS email,
    NULLIF(btrim((properties ->> 'first_name'::text)), ''::text) AS first_name,
    NULLIF(btrim((properties ->> 'last_name'::text)), ''::text) AS last_name,
    staging.to_e164((properties ->> 'phone'::text)) AS phone,
    NULLIF(btrim((properties ->> 'company'::text)), ''::text) AS company,
    loaded_at,
    batch_id
   FROM raw.web_event
  WHERE (event_name = 'form_submit'::text);


--
-- Name: web_event; Type: VIEW; Schema: staging; Owner: -
--

CREATE VIEW staging.web_event AS
 SELECT source_event_id,
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


--
-- Name: touchpoint touchpoint_id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.touchpoint ALTER COLUMN touchpoint_id SET DEFAULT nextval('core.touchpoint_touchpoint_id_seq'::regclass);


--
-- Name: conversion conversion_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.conversion
    ADD CONSTRAINT conversion_pkey PRIMARY KEY (conversion_id);


--
-- Name: customer_profile customer_profile_anchor_key_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customer_profile
    ADD CONSTRAINT customer_profile_anchor_key_key UNIQUE (anchor_key);


--
-- Name: customer_profile customer_profile_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customer_profile
    ADD CONSTRAINT customer_profile_pkey PRIMARY KEY (profile_id);


--
-- Name: identity_link identity_link_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_link
    ADD CONSTRAINT identity_link_pkey PRIMARY KEY (profile_id, id_type, id_value);


--
-- Name: lead_score lead_score_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.lead_score
    ADD CONSTRAINT lead_score_pkey PRIMARY KEY (profile_id);


--
-- Name: link_evidence link_evidence_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.link_evidence
    ADD CONSTRAINT link_evidence_pkey PRIMARY KEY (run_id, left_key, right_key);


--
-- Name: touchpoint touchpoint_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.touchpoint
    ADD CONSTRAINT touchpoint_pkey PRIMARY KEY (touchpoint_id);


--
-- Name: touchpoint touchpoint_source_table_source_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.touchpoint
    ADD CONSTRAINT touchpoint_source_table_source_id_key UNIQUE (source_table, source_id);


--
-- Name: truth_hazard_pair truth_hazard_pair_pkey; Type: CONSTRAINT; Schema: eval; Owner: -
--

ALTER TABLE ONLY eval.truth_hazard_pair
    ADD CONSTRAINT truth_hazard_pair_pkey PRIMARY KEY (person_a, person_b);


--
-- Name: truth_record truth_record_pkey; Type: CONSTRAINT; Schema: eval; Owner: -
--

ALTER TABLE ONLY eval.truth_record
    ADD CONSTRAINT truth_record_pkey PRIMARY KEY (unit_type, unit_key);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: ad_click ad_click_pkey; Type: CONSTRAINT; Schema: raw; Owner: -
--

ALTER TABLE ONLY raw.ad_click
    ADD CONSTRAINT ad_click_pkey PRIMARY KEY (source_event_id);


--
-- Name: crm_contact crm_contact_pkey; Type: CONSTRAINT; Schema: raw; Owner: -
--

ALTER TABLE ONLY raw.crm_contact
    ADD CONSTRAINT crm_contact_pkey PRIMARY KEY (crm_id);


--
-- Name: crm_opportunity crm_opportunity_pkey; Type: CONSTRAINT; Schema: raw; Owner: -
--

ALTER TABLE ONLY raw.crm_opportunity
    ADD CONSTRAINT crm_opportunity_pkey PRIMARY KEY (opp_id);


--
-- Name: web_event web_event_pkey; Type: CONSTRAINT; Schema: raw; Owner: -
--

ALTER TABLE ONLY raw.web_event
    ADD CONSTRAINT web_event_pkey PRIMARY KEY (source_event_id);


--
-- Name: conversion_mql_once; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX conversion_mql_once ON core.conversion USING btree (profile_id) WHERE (kind = 'mql'::text);


--
-- Name: conversion_profile_id_occurred_at_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX conversion_profile_id_occurred_at_idx ON core.conversion USING btree (profile_id, occurred_at);


--
-- Name: conversion_won_once; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX conversion_won_once ON core.conversion USING btree (source_id) WHERE (kind = 'won'::text);


--
-- Name: identity_link_unit_unique; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX identity_link_unit_unique ON core.identity_link USING btree (id_type, id_value) WHERE (id_type = ANY (ARRAY['crm_id'::text, 'form_submission'::text, 'anonymous_id'::text, 'opp_id'::text]));


--
-- Name: link_evidence_left_key_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX link_evidence_left_key_idx ON core.link_evidence USING btree (left_key);


--
-- Name: link_evidence_right_key_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX link_evidence_right_key_idx ON core.link_evidence USING btree (right_key);


--
-- Name: touchpoint_profile_id_occurred_at_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX touchpoint_profile_id_occurred_at_idx ON core.touchpoint USING btree (profile_id, occurred_at);


--
-- Name: truth_record_person_id_idx; Type: INDEX; Schema: eval; Owner: -
--

CREATE INDEX truth_record_person_id_idx ON eval.truth_record USING btree (person_id);


--
-- Name: ad_click_anonymous_id_idx; Type: INDEX; Schema: raw; Owner: -
--

CREATE INDEX ad_click_anonymous_id_idx ON raw.ad_click USING btree (anonymous_id);


--
-- Name: crm_opportunity_crm_id_idx; Type: INDEX; Schema: raw; Owner: -
--

CREATE INDEX crm_opportunity_crm_id_idx ON raw.crm_opportunity USING btree (crm_id);


--
-- Name: web_event_anonymous_id_occurred_at_idx; Type: INDEX; Schema: raw; Owner: -
--

CREATE INDEX web_event_anonymous_id_occurred_at_idx ON raw.web_event USING btree (anonymous_id, occurred_at);


--
-- Name: conversion conversion_profile_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.conversion
    ADD CONSTRAINT conversion_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES core.customer_profile(profile_id) ON DELETE CASCADE;


--
-- Name: identity_link identity_link_profile_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.identity_link
    ADD CONSTRAINT identity_link_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES core.customer_profile(profile_id) ON DELETE CASCADE;


--
-- Name: lead_score lead_score_profile_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.lead_score
    ADD CONSTRAINT lead_score_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES core.customer_profile(profile_id) ON DELETE CASCADE;


--
-- Name: touchpoint touchpoint_profile_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.touchpoint
    ADD CONSTRAINT touchpoint_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES core.customer_profile(profile_id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('001'),
    ('002');
