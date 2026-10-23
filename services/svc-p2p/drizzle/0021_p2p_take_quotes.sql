-- P-trade-orders-06: a locked take quote. The taker asks for one before placing;
-- it holds the price, the fee and the coin and fiat amounts until expires_at,
-- and trades.take with its quote_id refuses p2p.quote_expired after that, or
-- p2p.quote_changed when the price or the fee moved. No balance is stored here:
-- nothing is reserved until the take.
-- Reversal: 0021_p2p_take_quotes.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."take_quotes" (
  "quote_id" uuid PRIMARY KEY,
  "taker_id" text NOT NULL,
  "offer_id" uuid NOT NULL,
  "method" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL CHECK ("amount" > 0),
  "price" numeric(38, 18) NOT NULL CHECK ("price" > 0),
  "fiat_amount" numeric(38, 18) NOT NULL CHECK ("fiat_amount" > 0),
  "fee_bps" integer NOT NULL CHECK ("fee_bps" >= 0),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "take_quotes_window_ck" CHECK ("expires_at" > "created_at")
);
CREATE INDEX IF NOT EXISTS "take_quotes_taker_idx" ON "p2p"."take_quotes" ("taker_id", "created_at");
