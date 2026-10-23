-- migrate:up

-- Device attachment rule (d), ADR 0004: a session that contains a form fill
-- goes to that fill's profile, and every other session on the device follows
-- the device's majority profile. services/stitch writes one 'session_id' link
-- per session with a deciding form fill (source 'session'), next to the
-- device's 'anonymous_id' link. An event's profile is its session's link if it
-- has one, else its device's. A session belongs to exactly one profile.
ALTER TABLE core.identity_link DROP CONSTRAINT identity_link_id_type_check;
ALTER TABLE core.identity_link ADD CONSTRAINT identity_link_id_type_check
  CHECK (id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'opp_id', 'session_id',
                     'email', 'phone'));

DROP INDEX core.identity_link_unit_unique;
CREATE UNIQUE INDEX identity_link_unit_unique
  ON core.identity_link (id_type, id_value)
  WHERE id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'opp_id', 'session_id');

-- migrate:down
DELETE FROM core.identity_link WHERE id_type = 'session_id';

DROP INDEX core.identity_link_unit_unique;
CREATE UNIQUE INDEX identity_link_unit_unique
  ON core.identity_link (id_type, id_value)
  WHERE id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'opp_id');

ALTER TABLE core.identity_link DROP CONSTRAINT identity_link_id_type_check;
ALTER TABLE core.identity_link ADD CONSTRAINT identity_link_id_type_check
  CHECK (id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'opp_id', 'email', 'phone'));
