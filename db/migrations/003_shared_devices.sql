-- migrate:up

-- Shared devices (docs/acceptance.md, change log 2026-10-22): a new hazard kind,
-- and the true person of every tracked event, so wrong attachment can be
-- measured per event rather than per device. Written by the generator only.
ALTER TABLE eval.truth_hazard_pair DROP CONSTRAINT truth_hazard_pair_kind_check;
ALTER TABLE eval.truth_hazard_pair ADD CONSTRAINT truth_hazard_pair_kind_check
  CHECK (kind IN ('same_name_relative', 'shared_household_phone', 'shared_device'));

CREATE TABLE eval.truth_event (
  source_table    TEXT NOT NULL CHECK (source_table IN ('web_event', 'ad_click')),
  source_event_id TEXT NOT NULL,
  person_id       TEXT NOT NULL,
  PRIMARY KEY (source_table, source_event_id)
);

CREATE INDEX ON eval.truth_event (person_id);

-- migrate:down
DROP TABLE eval.truth_event;

DELETE FROM eval.truth_hazard_pair WHERE kind = 'shared_device';
ALTER TABLE eval.truth_hazard_pair DROP CONSTRAINT truth_hazard_pair_kind_check;
ALTER TABLE eval.truth_hazard_pair ADD CONSTRAINT truth_hazard_pair_kind_check
  CHECK (kind IN ('same_name_relative', 'shared_household_phone'));
