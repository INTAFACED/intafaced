-- P-trade-orders-11 / J-p2p-02 #4: a bank rail's confirmation that does not match its order exactly (currency,
-- amount or the order's reference) releases nothing and is recorded here for a person to review. One row per order
-- and rail confirmation, so the same confirmation read again writes nothing new. Fiat never moves on the platform and
-- no balance is stored here.
-- Reversal: 20261024141500_p2p_rail_exceptions.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."rail_exceptions" (
  "confirmation_id" text NOT NULL,
  "trade_id" uuid NOT NULL REFERENCES "p2p"."p2p_trades" ("id"),
  "reason" text NOT NULL,
  "expected_currency" text NOT NULL,
  "expected_amount" numeric(38, 18) NOT NULL,
  "received_currency" text NOT NULL,
  "received_amount" numeric(38, 18) NOT NULL,
  "received_reference" text NOT NULL,
  "recorded_at" timestamptz NOT NULL,
  PRIMARY KEY ("trade_id", "confirmation_id"),
  CONSTRAINT "rail_exceptions_reason_ck" CHECK ("reason" IN ('currency', 'amount', 'reference'))
);
