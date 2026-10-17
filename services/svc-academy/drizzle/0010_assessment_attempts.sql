-- svc-academy · assessment attempts (score only — no answer key stored)
-- Reversal: 0010_assessment_attempts.down.sql
--
-- Question sets and pass marks stay in the code catalog. This table stores
-- the caller's score. client_attempt_id makes a replay return the first row.

CREATE TABLE IF NOT EXISTS "academy"."assessment_attempts" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            uuid NOT NULL,
  "slug"               text NOT NULL,
  "client_attempt_id"  text NOT NULL,
  "score"              integer NOT NULL,
  "max_score"          integer NOT NULL,
  "passed"             boolean NOT NULL,
  "submitted_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "assessment_attempts_client_uq" UNIQUE ("user_id", "client_attempt_id")
);

CREATE INDEX IF NOT EXISTS "assessment_attempts_user_slug_idx"
  ON "academy"."assessment_attempts" ("user_id", "slug", "submitted_at" DESC);
