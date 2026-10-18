-- Customer wallet inbounds and withdrawals for slice S38.
-- Reversal: 0092_pay_wallet_slice.down.sql
--
-- These rows record an inbound that is not yet spendable, and a customer
-- withdrawal whose hold is still in the ledger. They do not store a balance.

CREATE TABLE IF NOT EXISTS "pay"."wallet_inbounds" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "network" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "rail_ref" text NOT NULL,
  "acceptance_address" text,
  "status" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_inbounds_rail_ref_uq" UNIQUE ("rail_ref"),
  CONSTRAINT "wallet_inbounds_status_ck" CHECK ("status" IN ('uncredited', 'credited', 'refused')),
  CONSTRAINT "wallet_inbounds_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "wallet_inbounds_asset_ck" CHECK (length(btrim("asset_id")) > 0),
  CONSTRAINT "wallet_inbounds_network_ck" CHECK (length(btrim("network")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."wallet_withdrawals" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "network" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "fee" numeric(38, 18),
  "client_ref" text NOT NULL,
  "destination_ref" text NOT NULL,
  "status" text NOT NULL,
  "hold_amount" numeric(38, 18) NOT NULL,
  "recipient" jsonb NOT NULL,
  "attempts" jsonb NOT NULL,
  "reversed" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_withdrawals_user_client_uq" UNIQUE ("user_id", "client_ref"),
  CONSTRAINT "wallet_withdrawals_status_ck"
    CHECK ("status" IN ('pending', 'held', 'sent', 'failed', 'cancelled', 'needs-info')),
  CONSTRAINT "wallet_withdrawals_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "wallet_withdrawals_hold_ck" CHECK ("hold_amount" >= 0),
  CONSTRAINT "wallet_withdrawals_recipient_ck" CHECK (jsonb_typeof("recipient") = 'object'),
  CONSTRAINT "wallet_withdrawals_attempts_ck" CHECK (jsonb_typeof("attempts") = 'array')
);

CREATE INDEX IF NOT EXISTS "wallet_withdrawals_user_asset_idx"
  ON "pay"."wallet_withdrawals" ("user_id", "asset_id");
