-- migrate:up

-- ADR 0002, implemented. Two changes to the channel definition; the canonical
-- copy is packages/marketing-logic/src/definitions.ts, and the parity test
-- (packages/marketing-logic/test/channel-parity.test.ts) fails on any difference.
--
-- 1. staging.channel_for knows the site's own host. A referrer on northbeam-cdp.example
--    (or a subdomain) is never a referral source: with no UTM tags it counts as no
--    referrer, so the event is 'direct'. Tags still win (rules 1 and 2 come first).
-- 2. staging.web_event.channel is the channel of the session's entry event, for every
--    event of the session (properties.session_id). The entry event is the earliest
--    one, ties broken by source_event_id in byte order. Events without a session_id keep their own
--    channel_for result.
CREATE OR REPLACE FUNCTION staging.channel_for(utm_source TEXT, utm_medium TEXT, referrer TEXT) RETURNS TEXT
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
    WHEN r ~ '^(https?://)?([a-z0-9-]+\.)*northbeam-cdp\.example([:/?#]|$)' THEN 'direct'
    WHEN r ~ '^(https?://)?([a-z0-9-]+\.)*(google|bing|duckduckgo|yahoo|ecosia)\.' THEN 'organic'
    ELSE 'referral'
  END
  FROM (
    SELECT NULLIF(lower(btrim(utm_source)), '') AS s,
           NULLIF(lower(btrim(utm_medium)), '') AS m,
           NULLIF(lower(btrim(referrer)), '') AS r
  ) AS norm
);

CREATE OR REPLACE VIEW staging.web_event AS
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
  CASE
    WHEN properties ->> 'session_id' IS NULL THEN own_channel
    ELSE first_value(own_channel) OVER (
      PARTITION BY properties ->> 'session_id' ORDER BY occurred_at, source_event_id COLLATE "C"
    )
  END AS channel,
  email,
  properties,
  loaded_at,
  batch_id
FROM (
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
    staging.channel_for(utm_source, utm_medium, referrer) AS own_channel,
    staging.normalize_email(email) AS email,
    properties,
    loaded_at,
    batch_id
  FROM raw.web_event
) AS e;

-- migrate:down
CREATE OR REPLACE VIEW staging.web_event AS
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

CREATE OR REPLACE FUNCTION staging.channel_for(utm_source TEXT, utm_medium TEXT, referrer TEXT) RETURNS TEXT
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
