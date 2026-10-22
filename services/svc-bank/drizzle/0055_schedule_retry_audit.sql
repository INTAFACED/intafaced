-- BK-xfer-10 review #7: an audit row for every operator retry of a standing-order run.
-- The row commits in the same transaction as the settle, so an approved money action is never unrecorded.
-- It records the operator (actor), the proposer and the second approver from identity, the approval id, the reason,
-- the payload hash the approval was bound to, and the outcome.
--
-- Reversal: 0055_schedule_retry_audit.down.sql

CREATE TABLE IF NOT EXISTS "bank"."schedule_retry_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_id" uuid NOT NULL REFERENCES "bank"."scheduled_transfers" ("id"),
  "occurrence" integer NOT NULL,
  "actor_id" text NOT NULL,
  "requester_id" text NOT NULL,
  "approver_id" text NOT NULL,
  "approval_id" text NOT NULL UNIQUE,
  "reason" text NOT NULL,
  "payload_hash" text NOT NULL,
  "outcome" text NOT NULL,
  "ledger_tx_id" text,
  "rejection_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "schedule_retry_audit_second_person_ck" CHECK (lower("approver_id") <> lower("requester_id") AND lower("approver_id") <> lower("actor_id"))
);
CREATE INDEX IF NOT EXISTS "schedule_retry_audit_schedule_idx" ON "bank"."schedule_retry_audit" ("schedule_id", "occurrence");
