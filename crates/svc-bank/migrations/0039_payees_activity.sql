-- Space-to-space transfer words, private activity notes and disputes (BANKPAY 17-21).
-- Saved recipients live in identity (recipients.list/add/remove), not here.
-- A personal send's note and reference live on bank.personal_transfers.
--
-- None of these tables holds a balance. A transfer message is the words both
-- parties may read; a private note is the writer's alone. A dispute is an open
-- case: this migration has no resolution, no refund and no invented outcome.
--
-- Reversal: 0039_payees_activity.down.sql

ALTER TABLE "bank"."personal_transfers" ADD COLUMN IF NOT EXISTS "reference" text;
ALTER TABLE "bank"."personal_transfers" DROP CONSTRAINT IF EXISTS "personal_transfers_reference_ck";
ALTER TABLE "bank"."personal_transfers"
  ADD CONSTRAINT "personal_transfers_reference_ck" CHECK (
    "reference" IS NULL OR (
      char_length("reference") BETWEEN 1 AND 64
      AND "reference" !~ '[^ -~]'
    )
  );

CREATE TABLE IF NOT EXISTS "bank"."transfer_messages" (
  "transfer_id"   text PRIMARY KEY,
  "ledger_tx_id"  text,
  "from_user_id"  uuid NOT NULL,
  "to_user_id"    uuid NOT NULL,
  "note"          text,
  "reference"     text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "transfer_messages_has_words" CHECK ("note" IS NOT NULL OR "reference" IS NOT NULL),
  CONSTRAINT "transfer_messages_note_len" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 140),
  CONSTRAINT "transfer_messages_reference_len" CHECK ("reference" IS NULL OR char_length("reference") BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS "transfer_messages_tx_idx"
  ON "bank"."transfer_messages" ("ledger_tx_id")
  WHERE "ledger_tx_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "bank"."activity_notes" (
  "user_id"     uuid NOT NULL,
  "activity_id" text NOT NULL,
  "text"        text NOT NULL,
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "activity_id"),
  CONSTRAINT "activity_notes_text_len" CHECK (char_length("text") BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS "bank"."activity_note_commands" (
  "command_id"  text PRIMARY KEY,
  "user_id"     uuid NOT NULL,
  "activity_id" text NOT NULL,
  "text"        text NOT NULL,
  "updated_at"  timestamptz NOT NULL,
  CONSTRAINT "activity_note_commands_id_len" CHECK (char_length("command_id") BETWEEN 8 AND 64)
);

CREATE TABLE IF NOT EXISTS "bank"."activity_disputes" (
  "id"          uuid PRIMARY KEY,
  "user_id"     uuid NOT NULL,
  "activity_id" text NOT NULL,
  "reason"      text NOT NULL,
  "status"      text NOT NULL DEFAULT 'open',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "activity_disputes_status" CHECK ("status" = 'open'),
  CONSTRAINT "activity_disputes_reason_len" CHECK (char_length("reason") BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX IF NOT EXISTS "activity_disputes_user_activity_idx"
  ON "bank"."activity_disputes" ("user_id", "activity_id");
