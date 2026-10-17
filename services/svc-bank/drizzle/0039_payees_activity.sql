-- Saved payees, transfer notes, private activity notes and disputes (BANKPAY 16-21).
--
-- None of these tables holds a balance. A transfer note is the words both
-- parties may read; a private note is the writer's alone. A dispute is an open
-- case: this migration has no resolution, no refund and no invented outcome.
--
-- Reversal: 0039_payees_activity.down.sql

CREATE TABLE IF NOT EXISTS "bank"."payees" (
  "owner_user_id" uuid NOT NULL,
  "payee_user_id" uuid NOT NULL,
  "nickname"      text,
  "added_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_user_id", "payee_user_id"),
  CONSTRAINT "payees_not_self" CHECK ("owner_user_id" <> "payee_user_id"),
  CONSTRAINT "payees_nickname_len" CHECK ("nickname" IS NULL OR char_length("nickname") BETWEEN 1 AND 40)
);

CREATE INDEX IF NOT EXISTS "payees_owner_added_idx"
  ON "bank"."payees" ("owner_user_id", "added_at" DESC);

CREATE TABLE IF NOT EXISTS "bank"."payee_commands" (
  "command_id"     text PRIMARY KEY,
  "owner_user_id"  uuid NOT NULL,
  "op"             text NOT NULL,
  "payee_user_id"  uuid NOT NULL,
  "nickname"       text,
  "outcome"        text NOT NULL,
  "added_at"       timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payee_commands_op" CHECK ("op" IN ('add', 'remove')),
  CONSTRAINT "payee_commands_outcome" CHECK ("outcome" IN ('saved', 'removed', 'absent')),
  CONSTRAINT "payee_commands_id_len" CHECK (char_length("command_id") BETWEEN 8 AND 64)
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
