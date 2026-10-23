-- J-bank-05 #3 (BK-xfer-03): a global-send quote is a rate lock. Taking a quote keeps the provider's figures for one
-- customer, asset, amount and currency until the provider's valid-until; a send names the lock it was confirmed on and is
-- paid at exactly those figures. One lock pays one send.
CREATE TABLE IF NOT EXISTS "bank"."global_quotes" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "asset_id" text NOT NULL,
  "amount" text NOT NULL,
  "to_currency" text NOT NULL,
  "rate" text NOT NULL,
  "fee" text NOT NULL,
  "fee_asset" text NOT NULL,
  "receive_amount" text NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "eta" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "global_quotes_decimals_ck" CHECK (
    "amount" ~ '^[0-9]+(\.[0-9]{1,18})?$' AND "rate" ~ '^[0-9]+(\.[0-9]{1,18})?$'
    AND "fee" ~ '^[0-9]+(\.[0-9]{1,18})?$' AND "receive_amount" ~ '^[0-9]+(\.[0-9]{1,18})?$'
  )
);
CREATE INDEX IF NOT EXISTS "global_quotes_user_idx" ON "bank"."global_quotes" ("user_id", "created_at");
ALTER TABLE "bank"."global_sends" ADD COLUMN IF NOT EXISTS "quote_id" uuid REFERENCES "bank"."global_quotes" ("id");
CREATE UNIQUE INDEX IF NOT EXISTS "global_sends_quote_uq" ON "bank"."global_sends" ("quote_id") WHERE "quote_id" IS NOT NULL;
