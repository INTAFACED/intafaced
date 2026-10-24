-- P-trade-orders-23 / J-p2p-01 #7: the buyer-paid notice to the seller is owed from the moment the trade
-- moves to fiat_sent, in the same row and the same transaction. `fiat_sent_notice_at` says when
-- `p2p.trade_fiat.sent` was handed to the bus; while it is null on a fiat_sent trade the notice is
-- still owed and the sweep hands it over again (the bus dedupes on the trade id). No balance is stored here.
-- Reversal: 0024_p2p_fiat_sent_notice.down.sql
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "fiat_sent_notice_at" timestamptz;

-- Trades that were marked paid before this column existed are not owed a notice now: the seller has
-- long since seen the order, and a late "check the payment" notice would mislead.
UPDATE "p2p"."p2p_trades" SET "fiat_sent_notice_at" = "fiat_sent_at"
 WHERE "fiat_sent_at" IS NOT NULL AND "fiat_sent_notice_at" IS NULL;

CREATE INDEX IF NOT EXISTS "p2p_trades_fiat_sent_notice_owed_idx"
  ON "p2p"."p2p_trades" ("fiat_sent_at")
  WHERE "status" = 'fiat_sent' AND "fiat_sent_notice_at" IS NULL;
