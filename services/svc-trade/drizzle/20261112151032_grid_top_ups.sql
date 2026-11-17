-- trade.grid_bot_top_ups · a quote top-up of a running grid bot (CB-bots-04; J-copy-bots-otc-15 #1)
-- Reversal: 20261112151032_grid_top_ups.down.sql
--
-- A top-up raises the bot's investment and its reserve row by the same amount, under the owner's reserve lock, and
-- re-plans the levels for the new investment once (reinit_count counts those re-plans). It posts no ledger row: the
-- reserve is a svc-trade limit row, not a balance, and every level order still takes its own order hold.
--
-- One row per applied top-up, keyed bots.grid.topup:<bot_id>:<request_id>, so a retry after a lost reply reads this row
-- instead of topping up twice.

ALTER TABLE "trade"."grid_bots" ADD COLUMN IF NOT EXISTS "reinit_count" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "trade"."grid_bot_top_ups" (
  "top_up_key"        text PRIMARY KEY,
  "bot_id"            text NOT NULL REFERENCES "trade"."grid_bots" ("bot_id"),
  "user_id"           text NOT NULL,
  "request_id"        text NOT NULL,
  "request_hash"      text NOT NULL,
  "asset"             text NOT NULL,
  "amount"            numeric(38, 18) NOT NULL,
  "investment_before" numeric(38, 18) NOT NULL,
  "investment_after"  numeric(38, 18) NOT NULL,
  "free_before"       numeric(38, 18) NOT NULL,
  "applied_at"        timestamptz NOT NULL,
  CONSTRAINT "grid_bot_top_ups_key_ck" CHECK ("top_up_key" = 'bots.grid.topup:' || "bot_id" || ':' || "request_id"),
  CONSTRAINT "grid_bot_top_ups_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "grid_bot_top_ups_investment_ck" CHECK ("investment_after" = "investment_before" + "amount"),
  CONSTRAINT "grid_bot_top_ups_free_ck" CHECK ("free_before" >= "amount")
);

CREATE INDEX IF NOT EXISTS "grid_bot_top_ups_bot_idx" ON "trade"."grid_bot_top_ups" ("bot_id", "applied_at");
