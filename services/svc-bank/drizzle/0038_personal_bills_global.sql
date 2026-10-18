-- Personal bill pay and global send (PAYBILLS).
--
-- These rows are instructions and outcomes. There is no balance column.
-- "How much left the space" is the ledger transaction id, or null when the
-- partner rail refused before a post. Amounts are the canonical decimal
-- string, not a second book.
--
-- A blank PSP / rate / corridor / travel-rule config never inserts a success
-- and never posts. Failed rows exist so a retry of the same idempotency key
-- is the same refusal.
--
-- Reversal: 0038_personal_bills_global.down.sql

CREATE TABLE IF NOT EXISTS "bank"."bill_payments" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "biller_id" text NOT NULL,
  "reference" text NOT NULL,
  "amount" text NOT NULL,
  "asset_id" text NOT NULL,
  "from_space_id" uuid NOT NULL,
  "status" text NOT NULL,
  "failure_code" text,
  "failure_blocker" text,
  "provider_ref" text,
  "ledger_tx_id" text,
  "recurring_id" uuid,
  "occurrence" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bill_payments_user_key_uq" UNIQUE ("user_id", "idempotency_key"),
  CONSTRAINT "bill_payments_status_ck" CHECK ("status" IN ('submitted', 'accepted', 'paid', 'failed', 'returned')),
  CONSTRAINT "bill_payments_amount_ck" CHECK ("amount" ~ '^[0-9]+(\.[0-9]{1,18})?$'),
  CONSTRAINT "bill_payments_failed_ck" CHECK (
    ("status" = 'failed' AND "failure_code" IS NOT NULL AND "ledger_tx_id" IS NULL)
    OR ("status" <> 'failed' AND "failure_code" IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS "bill_payments_user_idx"
  ON "bank"."bill_payments" ("user_id", "created_at" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "bank"."bill_recurring" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "biller_id" text NOT NULL,
  "reference" text NOT NULL,
  "amount" text NOT NULL,
  "asset_id" text NOT NULL,
  "from_space_id" uuid NOT NULL,
  "cadence" text NOT NULL,
  "status" text NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz,
  "next_run_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bill_recurring_user_key_uq" UNIQUE ("user_id", "idempotency_key"),
  CONSTRAINT "bill_recurring_cadence_ck" CHECK ("cadence" IN ('weekly', 'monthly')),
  CONSTRAINT "bill_recurring_status_ck" CHECK ("status" IN ('active', 'paused', 'cancelled', 'completed')),
  CONSTRAINT "bill_recurring_amount_ck" CHECK ("amount" ~ '^[0-9]+(\.[0-9]{1,18})?$')
);

CREATE INDEX IF NOT EXISTS "bill_recurring_due_idx"
  ON "bank"."bill_recurring" ("status", "next_run_at");

CREATE TABLE IF NOT EXISTS "bank"."bill_recurring_firings" (
  "schedule_id" uuid NOT NULL REFERENCES "bank"."bill_recurring" ("id"),
  "occurrence" integer NOT NULL,
  "payment_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("schedule_id", "occurrence"),
  CONSTRAINT "bill_recurring_firings_occurrence_ck" CHECK ("occurrence" >= 0)
);

CREATE TABLE IF NOT EXISTS "bank"."global_recipients" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "label" text,
  "name" text NOT NULL,
  "account" text NOT NULL,
  "account_kind" text NOT NULL,
  "bic" text,
  "country" text NOT NULL,
  "removed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "global_recipients_user_key_uq" UNIQUE ("user_id", "idempotency_key"),
  CONSTRAINT "global_recipients_kind_ck" CHECK ("account_kind" IN ('iban', 'ifsc', 'account_number')),
  CONSTRAINT "global_recipients_country_ck" CHECK ("country" ~ '^[A-Z]{2}$')
);

CREATE INDEX IF NOT EXISTS "global_recipients_user_idx"
  ON "bank"."global_recipients" ("user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "bank"."global_sends" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "from_space_id" uuid NOT NULL,
  "asset_id" text NOT NULL,
  "amount" text NOT NULL,
  "to_currency" text NOT NULL,
  "recipient_id" uuid NOT NULL,
  "country" text NOT NULL,
  "delivery_method" text NOT NULL,
  "compliance" text,
  "status" text NOT NULL,
  "failure_code" text,
  "failure_blocker" text,
  "provider_ref" text,
  "quote_rate" text,
  "quote_fee" text,
  "quote_fee_asset" text,
  "quote_receive" text,
  "quote_valid_until" timestamptz,
  "quote_eta" text,
  "ledger_tx_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "global_sends_user_key_uq" UNIQUE ("user_id", "idempotency_key"),
  CONSTRAINT "global_sends_status_ck" CHECK ("status" IN ('submitted', 'sent', 'on_the_way', 'arrived', 'failed')),
  CONSTRAINT "global_sends_amount_ck" CHECK ("amount" ~ '^[0-9]+(\.[0-9]{1,18})?$'),
  CONSTRAINT "global_sends_failed_ck" CHECK (
    ("status" = 'failed' AND "failure_code" IS NOT NULL AND "ledger_tx_id" IS NULL)
    OR ("status" <> 'failed' AND "failure_code" IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS "global_sends_user_idx"
  ON "bank"."global_sends" ("user_id", "created_at" DESC, "id" DESC);
