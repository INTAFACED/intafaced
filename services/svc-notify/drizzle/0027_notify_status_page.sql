-- svc-notify · public status page: components, readings and owner values (SP-status-01)
-- Reversal: 0027_notify_status_page.down.sql
--
-- The founders define the components the public /status page shows. A component's state comes from a reading (a health
-- record with its source and time) or from a published incident or maintenance notice that names it; nothing is seeded
-- and no state is typed in. One row holds the definition and the three owner values, each NULL until a founder sets it.
-- Every change is appended to the log under a business key (`status.page:r<revision>`) with who made it and why. A
-- reading is keyed by (component, observed_at), so a replayed reading is one row. The log and the readings refuse update
-- and delete.
CREATE TABLE IF NOT EXISTS notify.status_page (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  components jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(components) = 'array'),
  component_cap integer CHECK (component_cap IS NULL OR component_cap BETWEEN 1 AND 100),
  staleness_seconds integer CHECK (staleness_seconds IS NULL OR staleness_seconds BETWEEN 1 AND 604800),
  uptime_days integer CHECK (uptime_days IS NULL OR uptime_days BETWEEN 1 AND 90),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by text,
  updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS notify.status_page_log (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  revision_after integer NOT NULL UNIQUE CHECK (revision_after >= 1),
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  set_by text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  set_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS notify.status_readings (
  component_id text NOT NULL CHECK (component_id ~ '^[a-z][a-z0-9-]{1,39}$'),
  observed_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance')),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (component_id, observed_at)
);
CREATE INDEX IF NOT EXISTS status_readings_observed_idx ON notify.status_readings (observed_at);
CREATE OR REPLACE FUNCTION notify.status_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
DROP TRIGGER IF EXISTS status_page_log_append_only ON notify.status_page_log;
CREATE TRIGGER status_page_log_append_only BEFORE UPDATE OR DELETE ON notify.status_page_log
  FOR EACH ROW EXECUTE FUNCTION notify.status_append_only();
DROP TRIGGER IF EXISTS status_readings_append_only ON notify.status_readings;
CREATE TRIGGER status_readings_append_only BEFORE UPDATE OR DELETE ON notify.status_readings
  FOR EACH ROW EXECUTE FUNCTION notify.status_append_only();

-- Incident and maintenance notices may name a status page component as well as the three built-in ones. The table keeps
-- the shape, and a trigger refuses a name that is neither built in nor defined on the page when the row is written.
ALTER TABLE "notify"."notices" DROP CONSTRAINT IF EXISTS "notices_components_ck";
ALTER TABLE "notify"."notices" ADD CONSTRAINT "notices_components_ck" CHECK (
  cardinality("components") = 0
  OR array_to_string("components", ',') ~ '^[a-z][a-z0-9-]{1,39}(,[a-z][a-z0-9-]{1,39})*$'
);
CREATE OR REPLACE FUNCTION notify.notice_components_known() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(NEW.components) > 0 AND EXISTS (
    SELECT 1 FROM unnest(NEW.components) AS named(id)
    WHERE named.id NOT IN ('api', 'webhooks', 'console')
      AND NOT EXISTS (
        SELECT 1 FROM notify.status_page p, jsonb_array_elements(p.components) AS c
        WHERE c ->> 'id' = named.id
      )
  ) THEN
    RAISE EXCEPTION 'notify.notice_component_unknown' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS notice_components_known ON notify.notices;
CREATE TRIGGER notice_components_known BEFORE INSERT OR UPDATE OF components ON notify.notices
  FOR EACH ROW EXECUTE FUNCTION notify.notice_components_known();
