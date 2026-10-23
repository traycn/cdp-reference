-- migrate:up

-- Lifecycle stage history (docs/definitions.md, "Stages only move forward").
-- core.customer_profile.lifecycle_stage is the current stage; this table is every stage a
-- profile has had, in order. seq 1 is the first stage recorded for the profile. A row
-- whose stage is lower than the previous row's needs a non-blank reason, enforced by the
-- trigger below, so no code path can record a backward move silently.
-- services/lifecycle writes it; the history of a profile restarts when a new dataset is
-- loaded (materialize --new-dataset), and goes with the profile when stitching drops it.
CREATE TABLE core.lifecycle_history (
  profile_id  UUID NOT NULL REFERENCES core.customer_profile (profile_id) ON DELETE CASCADE,
  seq         INT NOT NULL CHECK (seq >= 1),
  stage       TEXT NOT NULL CHECK (stage IN ('lead', 'mql', 'sql', 'opportunity', 'won')),
  reason      TEXT CHECK (reason IS NULL OR btrim(reason) <> ''),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, seq)
);

CREATE FUNCTION core.lifecycle_history_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  stages CONSTANT TEXT[] := ARRAY['lead', 'mql', 'sql', 'opportunity', 'won'];
  prev TEXT;
BEGIN
  SELECT stage INTO prev FROM core.lifecycle_history
  WHERE profile_id = NEW.profile_id AND seq < NEW.seq
  ORDER BY seq DESC LIMIT 1;
  IF prev IS NOT NULL
     AND array_position(stages, NEW.stage) < array_position(stages, prev)
     AND NEW.reason IS NULL THEN
    RAISE EXCEPTION 'lifecycle stage of % moves backward (% to %) without a reason',
      NEW.profile_id, prev, NEW.stage;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER lifecycle_history_forward_only
  BEFORE INSERT ON core.lifecycle_history
  FOR EACH ROW EXECUTE FUNCTION core.lifecycle_history_forward_only();

-- migrate:down
DROP TABLE core.lifecycle_history;
DROP FUNCTION core.lifecycle_history_forward_only();
