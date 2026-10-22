-- BK-xfer-10: one-off scheduled payments (`once` cadence) and standing-order edits by revision.
--
-- An edit keeps the schedule id, so the ledger key `bank.transfer.sched:<scheduleId>:<occurrence>` keeps collapsing
-- retries (a cancel-and-replace would mint a new id and a new key). `revision` counts applied edits; the edits table
-- is the idempotency record of each one (no amounts: what each occurrence moved is in transfer_executions).
--
-- Reversal: 0053_schedule_once_edits.down.sql

DO $$ BEGIN
  ALTER TYPE "bank"."transfer_cadence" ADD VALUE 'once' BEFORE 'daily';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "bank"."scheduled_transfers" ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 0;
ALTER TABLE "bank"."scheduled_transfers" ADD COLUMN IF NOT EXISTS "reference" text;

CREATE TABLE IF NOT EXISTS "bank"."schedule_edits" (
  "schedule_id" uuid NOT NULL REFERENCES "bank"."scheduled_transfers" ("id"),
  "from_revision" integer NOT NULL,
  "payload_hash" text NOT NULL,
  "edited_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("schedule_id", "from_revision")
);
