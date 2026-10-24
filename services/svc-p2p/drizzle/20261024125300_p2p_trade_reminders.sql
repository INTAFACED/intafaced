-- P-trade-orders-15 / J-p2p-02 #2: the buyer reminds a slow seller to release. One row per reminder, numbered from 1
-- per order, written in the same transaction that checks the owner's wait and count against the order's locked row.
-- The row is also the outbox for `p2p.trade_reminder.sent`: `handed_at` says when it reached the bus; while it is null
-- the sweep hands it over again (the bus dedupes on trade id and number). No balance is stored here.
-- Reversal: 20261024125300_p2p_trade_reminders.down.sql
CREATE TABLE IF NOT EXISTS "p2p"."trade_reminders" (
  "trade_id" uuid NOT NULL REFERENCES "p2p"."p2p_trades" ("id"),
  "n" integer NOT NULL,
  "buyer_id" text NOT NULL,
  "seller_id" text NOT NULL,
  "reminded_at" timestamptz NOT NULL,
  "handed_at" timestamptz,
  -- The order left fiat_sent (released, disputed) before the reminder reached the bus: "please release" would be
  -- wrong by then, so it is closed unsent rather than owed forever.
  "dropped_at" timestamptz,
  PRIMARY KEY ("trade_id", "n"),
  CONSTRAINT "trade_reminders_n_ck" CHECK ("n" >= 1),
  CONSTRAINT "trade_reminders_parties_ck" CHECK ("buyer_id" <> "seller_id"),
  CONSTRAINT "trade_reminders_order_ck" CHECK ("handed_at" IS NULL OR "handed_at" >= "reminded_at"),
  CONSTRAINT "trade_reminders_one_end_ck" CHECK ("handed_at" IS NULL OR "dropped_at" IS NULL)
);

CREATE INDEX IF NOT EXISTS "trade_reminders_owed_idx"
  ON "p2p"."trade_reminders" ("reminded_at")
  WHERE "handed_at" IS NULL AND "dropped_at" IS NULL;
