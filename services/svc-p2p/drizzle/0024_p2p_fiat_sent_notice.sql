-- P-trade-orders-23 / J-p2p-01 #7: the buyer-paid notice to the seller, as an outbox row. markFiatSent
-- inserts it in the same transaction that moves the trade to fiat_sent, so the notice is owed from the
-- commit. `handed_at` says when `p2p.trade_fiat.sent` reached the bus; while it is null the sweep hands
-- it over again (the bus and svc-notify both dedupe on the trade id). No balance is stored here.
-- Reversal: 0024_p2p_fiat_sent_notice.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."fiat_sent_notices" (
  "trade_id" uuid PRIMARY KEY REFERENCES "p2p"."p2p_trades" ("id"),
  "buyer_id" text NOT NULL,
  "seller_id" text NOT NULL,
  "marked_at" timestamptz NOT NULL,
  "handed_at" timestamptz,
  -- The trade left fiat_sent (released, disputed) before the notice reached the bus: "check the payment before
  -- you release" would be wrong by then, so it is closed unsent rather than owed forever.
  "dropped_at" timestamptz,
  CONSTRAINT "fiat_sent_notices_parties_ck" CHECK ("buyer_id" <> "seller_id"),
  CONSTRAINT "fiat_sent_notices_order_ck" CHECK ("handed_at" IS NULL OR "handed_at" >= "marked_at"),
  CONSTRAINT "fiat_sent_notices_one_end_ck" CHECK ("handed_at" IS NULL OR "dropped_at" IS NULL)
);

CREATE INDEX IF NOT EXISTS "fiat_sent_notices_owed_idx"
  ON "p2p"."fiat_sent_notices" ("marked_at")
  WHERE "handed_at" IS NULL AND "dropped_at" IS NULL;
