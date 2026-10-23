-- migrate:up

-- M3: opportunities join their profile through a structural link
-- (opportunity → crm_id, confidence 1.0), written by services/stitch in SQL.
-- An opportunity belongs to exactly one CRM contact, so it is unique like the
-- other units.
ALTER TABLE core.identity_link DROP CONSTRAINT identity_link_id_type_check;
ALTER TABLE core.identity_link ADD CONSTRAINT identity_link_id_type_check
  CHECK (id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'opp_id', 'email', 'phone'));

DROP INDEX core.identity_link_unit_unique;
CREATE UNIQUE INDEX identity_link_unit_unique
  ON core.identity_link (id_type, id_value)
  WHERE id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'opp_id');

-- migrate:down
DELETE FROM core.identity_link WHERE id_type = 'opp_id';

DROP INDEX core.identity_link_unit_unique;
CREATE UNIQUE INDEX identity_link_unit_unique
  ON core.identity_link (id_type, id_value)
  WHERE id_type IN ('crm_id', 'form_submission', 'anonymous_id');

ALTER TABLE core.identity_link DROP CONSTRAINT identity_link_id_type_check;
ALTER TABLE core.identity_link ADD CONSTRAINT identity_link_id_type_check
  CHECK (id_type IN ('crm_id', 'form_submission', 'anonymous_id', 'email', 'phone'));
