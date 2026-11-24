-- Add money (BK-xfer-04, BK-xfer-05, J-bank-02): pay by bank as a method, a quote's delivery estimate, and the
-- customer's add-money requests.
--
-- An add-money request is kept whatever the rail answers: opened with the partner's instruction, or refused with the
-- rail and the reason when no partner is connected. It is written as `opening`, with the quote it was asked on, before
-- the partner is called, so a crash between the partner and this table never leaves an instruction with no request.
-- It is a record of what was asked, not a balance and not a credit.
-- Money reaches the balance only through the ledger's deposit recipe, never through this table.
--
-- Reversal: 0053_add_money_intents.down.sql

ALTER TABLE "bank"."ramp_onramp_quotes" DROP CONSTRAINT IF EXISTS "ramp_onramp_quotes_method_ck";
ALTER TABLE "bank"."ramp_onramp_quotes" ADD CONSTRAINT "ramp_onramp_quotes_method_ck"
  CHECK ("method" IN ('card', 'bank_transfer', 'pay_by_bank', 'wallet_pay'));
ALTER TABLE "bank"."ramp_onramp_quotes" ADD COLUMN IF NOT EXISTS "delivery_estimate" text;
ALTER TABLE "bank"."ramp_onramp_quotes" DROP CONSTRAINT IF EXISTS "ramp_onramp_quotes_estimate_ck";
ALTER TABLE "bank"."ramp_onramp_quotes" ADD CONSTRAINT "ramp_onramp_quotes_estimate_ck"
  CHECK ("delivery_estimate" IS NULL OR length(btrim("delivery_estimate")) BETWEEN 1 AND 140);

ALTER TABLE "bank"."customer_onramps" DROP CONSTRAINT IF EXISTS "customer_onramps_method_ck";
ALTER TABLE "bank"."customer_onramps" ADD CONSTRAINT "customer_onramps_method_ck"
  CHECK ("method" IN ('card', 'bank_transfer', 'pay_by_bank', 'wallet_pay'));

CREATE TABLE IF NOT EXISTS "bank"."add_money_requests" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "method" text NOT NULL,
  "country" text NOT NULL,
  "rail" text NOT NULL,
  "status" text NOT NULL,
  "refusal_code" text,
  "quote_id" uuid REFERENCES "bank"."ramp_onramp_quotes" ("id"),
  "onramp_id" uuid REFERENCES "bank"."customer_onramps" ("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "add_money_requests_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "add_money_requests_method_ck" CHECK ("method" IN ('card', 'bank_transfer', 'pay_by_bank', 'wallet_pay')),
  CONSTRAINT "add_money_requests_country_ck" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "add_money_requests_rail_ck" CHECK ("rail" IN ('rail.bank', 'rail.card')),
  CONSTRAINT "add_money_requests_status_ck" CHECK (
    ("status" = 'opening' AND "refusal_code" IS NULL AND "onramp_id" IS NULL AND "quote_id" IS NOT NULL)
    OR ("status" = 'refused' AND "refusal_code" IS NOT NULL AND "onramp_id" IS NULL)
    OR ("status" = 'opened' AND "refusal_code" IS NULL AND "onramp_id" IS NOT NULL AND "quote_id" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "add_money_requests_user_idx"
  ON "bank"."add_money_requests" ("user_id", "created_at" DESC);
