-- svc-identity · the verification review queue (I-kyc-compliance-02, J-identity-20 #1 #2). A submitted case has at most
-- one reviewer: a claim sets it with compare-and-set, so of two reviewers claiming at once one wins and the other is told
-- the case is taken. Reviewers keep internal notes on a case: append-only, never in anything the customer reads.
-- Reversal: the matching .down.sql
ALTER TABLE "identity"."kyc_cases" ADD COLUMN IF NOT EXISTS "assigned_to" text;
ALTER TABLE "identity"."kyc_cases" ADD COLUMN IF NOT EXISTS "assigned_at" timestamptz;
-- The queue reads open cases oldest first, by (created_at, id), a page at a time.
CREATE INDEX IF NOT EXISTS "kyc_cases_open_queue_idx"
  ON "identity"."kyc_cases" ("created_at", "id") WHERE "state" = 'submitted';

CREATE TABLE IF NOT EXISTS "identity"."kyc_case_notes" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "case_id"    uuid NOT NULL REFERENCES "identity"."kyc_cases" ("id") ON DELETE CASCADE,
  "author_id"  text NOT NULL,
  "body"       text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 2000),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kyc_case_notes_case_idx" ON "identity"."kyc_case_notes" ("case_id", "created_at");
