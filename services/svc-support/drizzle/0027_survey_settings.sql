-- svc-support · satisfaction survey configuration (SP-csat-02)
-- Reversal: 0027_survey_settings.down.sql
--
-- One row per survey with its configuration and revision. At most one survey is active (partial unique index). Every
-- configure is appended to the log under a business key (`support.survey:<surveyId>:r<revision>`); the log refuses
-- update and delete. The survey cap is a blank owner value and is not stored here.

CREATE TABLE IF NOT EXISTS "support"."surveys" (
  "survey_id" uuid PRIMARY KEY,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "active" boolean NOT NULL,
  "config" jsonb NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "surveys_one_active_idx" ON "support"."surveys" ("active") WHERE "active";

CREATE TABLE IF NOT EXISTS "support"."survey_log" (
  "key" text PRIMARY KEY,
  "survey_id" uuid NOT NULL,
  "revision_after" integer NOT NULL CHECK ("revision_after" >= 1),
  "config" jsonb NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION "support"."survey_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.survey_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "survey_log_append_only_trg" ON "support"."survey_log";
CREATE TRIGGER "survey_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."survey_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."survey_log_append_only"();
