-- Personal earn (BK-earn-01): partial withdraw, the `deallocating` state, per-pool availability rules, earn settings
-- and the auto program. Business earn (business.earn.*) is BK-pots-04 and is not here (D51).
--
-- `waiting_accrual` is NOT stored: it is derived from opened_at (opened on the current UTC day). Only `deallocating`
-- is a stored state, because it marks a withdraw claim whose ledger post may be in flight.
--
-- Reversal: 0052_earn_personal.down.sql

DO $$ BEGIN
  ALTER TYPE "bank"."position_status" ADD VALUE 'deallocating' AFTER 'active';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One row per withdraw request (whole or partial). The (position, client event) pair is the retry key; the ledger key
-- is `bank.earn.withdraw:<positionId>:<clientEventId>`. A lost reply replays to the same row.
CREATE TABLE IF NOT EXISTS "bank"."earn_withdrawals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "position_id" uuid NOT NULL REFERENCES "bank"."earn_positions" ("id"),
  "client_event_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "status" text NOT NULL DEFAULT 'claimed',
  "ledger_tx_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "posted_at" timestamptz,
  CONSTRAINT "earn_withdrawals_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "earn_withdrawals_status_ck" CHECK ("status" IN ('claimed', 'posted')),
  CONSTRAINT "earn_withdrawals_posted_ck" CHECK (("status" = 'posted') = ("ledger_tx_id" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "earn_withdrawals_key_uq" ON "bank"."earn_withdrawals" ("position_id", "client_event_id");
-- At most one in-flight claim per position: the deallocating state has exactly one owner.
CREATE UNIQUE INDEX IF NOT EXISTS "earn_withdrawals_one_claim_uq" ON "bank"."earn_withdrawals" ("position_id") WHERE "status" = 'claimed';

-- Owner-set availability on top of the module gate. No row, or a null field, means "follow the module gate".
CREATE TABLE IF NOT EXISTS "bank"."earn_pool_availability" (
  "pool_id" uuid PRIMARY KEY REFERENCES "bank"."earn_pools" ("id"),
  "allowed_countries" text[],
  "min_verification_tier" integer,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "earn_pool_availability_countries_ck" CHECK ("allowed_countries" IS NULL OR cardinality("allowed_countries") > 0),
  CONSTRAINT "earn_pool_availability_tier_ck" CHECK ("min_verification_tier" IS NULL OR "min_verification_tier" BETWEEN 0 AND 10)
);

-- One auto program per (user, asset). A null cap is blank: it may be stored only while disabled.
CREATE TABLE IF NOT EXISTS "bank"."earn_auto_programs" (
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "pool_id" uuid NOT NULL REFERENCES "bank"."earn_pools" ("id"),
  "enabled" boolean NOT NULL,
  "cap" numeric(38, 18),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "asset_id"),
  CONSTRAINT "earn_auto_programs_cap_ck" CHECK ("cap" IS NULL OR "cap" > 0),
  CONSTRAINT "earn_auto_programs_enabled_cap_ck" CHECK (NOT "enabled" OR "cap" IS NOT NULL)
);

-- settings.set replay guard: the same commandId returns the stored result.
CREATE TABLE IF NOT EXISTS "bank"."earn_settings_commands" (
  "user_id" text NOT NULL,
  "command_id" text NOT NULL,
  "payload_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "command_id")
);
