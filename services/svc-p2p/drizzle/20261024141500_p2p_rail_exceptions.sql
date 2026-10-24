-- P-trade-orders-11 / J-p2p-02 #4: a bank rail's confirmation that does not match its order exactly (currency, amount
-- or the order's reference) releases nothing and is left here for a person. One row per rail confirmation, so the
-- same confirmation read again writes nothing new. Fiat never moves on the platform and no balance is stored here.
-- Reversal: 20261024141500_p2p_rail_exceptions.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."rail_exceptions" (
  "confirmation_id" text PRIMARY KEY,
  "trade_id" uuid NOT NULL REFERENCES "p2p"."p2p_trades" ("id"),
  "reason" text NOT NULL,
  "expected_currency" text NOT NULL,
  "expected_amount" numeric(38, 18) NOT NULL,
  "received_currency" text NOT NULL,
  "received_amount" numeric(38, 18) NOT NULL,
  "received_reference" text NOT NULL,
  "recorded_at" timestamptz NOT NULL,
  CONSTRAINT "rail_exceptions_reason_ck" CHECK ("reason" IN ('currency', 'amount', 'reference'))
);

CREATE INDEX IF NOT EXISTS "rail_exceptions_trade_idx" ON "p2p"."rail_exceptions" ("trade_id");
