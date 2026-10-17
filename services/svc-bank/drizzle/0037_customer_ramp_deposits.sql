-- Customer ramp quotes, saved-destination ids, and custody deposit addresses.
--
-- These rows are instructions and records. They are not balances.
-- A quote stores the decimals a rate source published. An on-ramp row stores
-- a partner payment instruction and does not credit the ledger. A deposit
-- address is the string custody issued. Nothing here is a running total.
--
-- Kind fiat still does not settle in this service. A blank PSP or a blank
-- custody port writes no row.
--
-- Reversal: 0037_customer_ramp_deposits.down.sql

ALTER TABLE "bank"."user_withdraw_destinations"
  ADD COLUMN IF NOT EXISTS "destination_id" uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS "label" text;

ALTER TABLE "bank"."user_withdraw_destinations"
  DROP CONSTRAINT IF EXISTS "user_withdraw_destinations_label_ck";

ALTER TABLE "bank"."user_withdraw_destinations"
  ADD CONSTRAINT "user_withdraw_destinations_label_ck" CHECK (
    "label" IS NULL OR (length(btrim("label")) BETWEEN 1 AND 64 AND "label" = btrim("label"))
  );

CREATE UNIQUE INDEX IF NOT EXISTS "user_withdraw_destinations_id_idx"
  ON "bank"."user_withdraw_destinations" ("destination_id");

CREATE TABLE IF NOT EXISTS "bank"."withdraw_destination_removals" (
  "user_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "destination_id" uuid NOT NULL,
  "removed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "idempotency_key"),
  CONSTRAINT "withdraw_destination_removals_key_ck" CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 128)
);

CREATE TABLE IF NOT EXISTS "bank"."ramp_onramp_quotes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "method" text NOT NULL,
  "country" text NOT NULL,
  "pay_amount" numeric(38, 18) NOT NULL,
  "fee" numeric(38, 18) NOT NULL,
  "rate" numeric(38, 18) NOT NULL,
  "pay_currency" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "simulated" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ramp_onramp_quotes_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "ramp_onramp_quotes_pay_ck" CHECK ("pay_amount" > 0),
  CONSTRAINT "ramp_onramp_quotes_fee_ck" CHECK ("fee" >= 0),
  CONSTRAINT "ramp_onramp_quotes_rate_ck" CHECK ("rate" > 0),
  CONSTRAINT "ramp_onramp_quotes_method_ck" CHECK ("method" IN ('card', 'bank_transfer', 'wallet_pay')),
  CONSTRAINT "ramp_onramp_quotes_country_ck" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "ramp_onramp_quotes_currency_ck" CHECK ("pay_currency" ~ '^[A-Z]{3,16}$'),
  CONSTRAINT "ramp_onramp_quotes_simulated_ck" CHECK ("simulated" = true)
);

CREATE INDEX IF NOT EXISTS "ramp_onramp_quotes_user_idx"
  ON "bank"."ramp_onramp_quotes" ("user_id", "created_at");

-- A customer on-ramp is a partner instruction (hosted URL or bank details).
-- Status stays pending_payment: this table never records a ledger credit.
CREATE TABLE IF NOT EXISTS "bank"."customer_onramps" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "quote_id" uuid NOT NULL REFERENCES "bank"."ramp_onramp_quotes" ("id"),
  "method" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "pay_amount" numeric(38, 18) NOT NULL,
  "fee" numeric(38, 18) NOT NULL,
  "rate" numeric(38, 18) NOT NULL,
  "pay_currency" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_payment',
  "simulated" boolean NOT NULL DEFAULT true,
  "partner_rail" text NOT NULL,
  "hosted_url" text,
  "bank_reference" text,
  "bank_account_name" text,
  "bank_account_ref" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "customer_onramps_status_ck" CHECK ("status" = 'pending_payment'),
  CONSTRAINT "customer_onramps_simulated_ck" CHECK ("simulated" = true),
  CONSTRAINT "customer_onramps_method_ck" CHECK ("method" IN ('card', 'bank_transfer', 'wallet_pay')),
  CONSTRAINT "customer_onramps_amount_ck" CHECK ("amount" > 0 AND "pay_amount" > 0 AND "fee" >= 0 AND "rate" > 0),
  CONSTRAINT "customer_onramps_instruction_ck" CHECK (
    (
      "hosted_url" IS NOT NULL
      AND "bank_reference" IS NULL
      AND "bank_account_name" IS NULL
      AND "bank_account_ref" IS NULL
    )
    OR (
      "hosted_url" IS NULL
      AND "bank_reference" IS NOT NULL
      AND "bank_account_name" IS NOT NULL
      AND "bank_account_ref" IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS "customer_onramps_user_idx"
  ON "bank"."customer_onramps" ("user_id", "created_at");

-- The address custody returned. Not a balance and not a locally derived key.
CREATE TABLE IF NOT EXISTS "bank"."deposit_addresses" (
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "network_id" text NOT NULL,
  "address" text NOT NULL,
  "memo" text,
  "qr_payload" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "asset_id", "network_id"),
  CONSTRAINT "deposit_addresses_address_ck" CHECK (length(btrim("address")) > 0 AND "address" = btrim("address"))
);
