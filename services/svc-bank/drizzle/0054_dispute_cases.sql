-- PP-disputes-safety-01: dispute cases keyed server-side `dispute:<userId>:<activityId>` (PD-1), and the owner-published
-- reason table (legal copy). No money columns: no money moves in this slice. The single-state `activity_disputes`
-- table (0039) stays for the old door.
--
-- Reversal: 0054_dispute_cases.down.sql

CREATE TABLE IF NOT EXISTS "bank"."dispute_reasons" (
  "code" text PRIMARY KEY,
  "label" text NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dispute_reasons_code_ck" CHECK ("code" ~ '^[a-z][a-z0-9_]{1,63}$')
);

CREATE TABLE IF NOT EXISTS "bank"."dispute_cases" (
  "id" uuid PRIMARY KEY,
  "case_key" text NOT NULL,
  "user_id" text NOT NULL,
  "activity_id" text NOT NULL,
  "reason_code" text NOT NULL REFERENCES "bank"."dispute_reasons" ("code"),
  "statement" text NOT NULL,
  "linked_activity_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'submitted',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dispute_cases_status_ck" CHECK ("status" IN ('submitted', 'info_requested', 'offered', 'accepted_offer', 'escalated',
    'under_review', 'resolved_buyer', 'resolved_seller', 'appealed', 'cancelled', 'auto_closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispute_cases_key_uq" ON "bank"."dispute_cases" ("case_key");
CREATE INDEX IF NOT EXISTS "dispute_cases_user_idx" ON "bank"."dispute_cases" ("user_id");
