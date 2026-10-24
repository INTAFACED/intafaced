-- P-trade-orders-20 / J-p2p-02 #3: the seller reports that the payment in their own bank is not the order's amount.
-- One row per order, written under the order's lock with the owner's band it was classified by (null when the band
-- was blank and a person decides). Fiat never moves on the platform and no balance is stored here.
-- Reversal: 20261024133500_p2p_trade_mismatches.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."trade_mismatches" (
  "trade_id" uuid PRIMARY KEY REFERENCES "p2p"."p2p_trades" ("id"),
  "seller_id" text NOT NULL,
  "kind" text NOT NULL,
  "amount_received" numeric(38, 18) NOT NULL,
  "expected" numeric(38, 18) NOT NULL,
  "classification" text NOT NULL,
  "tolerance_bps" integer,
  "reported_at" timestamptz NOT NULL,
  CONSTRAINT "trade_mismatches_kind_ck" CHECK ("kind" IN ('under', 'over', 'partial')),
  CONSTRAINT "trade_mismatches_amounts_ck" CHECK ("amount_received" > 0 AND "expected" > 0),
  CONSTRAINT "trade_mismatches_classification_ck" CHECK (
    ("classification" = 'reported' AND "tolerance_bps" IS NULL)
    OR ("classification" IN ('within_tolerance', 'outside_tolerance') AND "tolerance_bps" BETWEEN 0 AND 10000)
  )
);
