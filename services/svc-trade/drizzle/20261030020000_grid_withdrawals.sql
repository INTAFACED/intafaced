-- trade.grid_bot_withdrawals · grid bot profit withdrawals (CB-bots-05; J-copy-bots-otc-14 #7)
-- Reversal: 20261030020000_grid_withdrawals.down.sql
--
-- A closed pair's profit raises the bot's reserve row by that profit, so the profit stays guarded for the bot. A
-- withdrawal lowers the reserve row by its amount, at most the reserve less the investment, so the profit is free for
-- the owner's other uses. It posts no ledger row: the profit is already in the owner's balance, and the reserve is a
-- svc-trade limit row, not a balance.
--
-- One row per applied withdrawal, keyed bots.grid.withdraw:<bot_id>:<request_id>, so a retry after a lost reply reads
-- this row instead of withdrawing twice. Each receipt field is stored as it was decided, under the owner's reserve lock.
-- The owner's daily cap counts applied rows of one owner and asset in one UTC day.

CREATE TABLE IF NOT EXISTS "trade"."grid_bot_withdrawals" (
  "withdrawal_key"     text PRIMARY KEY,
  "bot_id"             text NOT NULL REFERENCES "trade"."grid_bots" ("bot_id"),
  "user_id"            text NOT NULL,
  "request_id"         text NOT NULL,
  "request_hash"       text NOT NULL,
  "asset"              text NOT NULL,
  "amount"             numeric(38, 18) NOT NULL,
  "profit_before"      numeric(38, 18) NOT NULL,
  "profit_after"       numeric(38, 18) NOT NULL,
  "reserve_before"     numeric(38, 18) NOT NULL,
  "reserve_after"      numeric(38, 18) NOT NULL,
  "daily_cap"          numeric(38, 18) NOT NULL,
  "cap_withdrawn_today"           numeric(38, 18) NOT NULL,
  "cap_remaining"      numeric(38, 18) NOT NULL,
  "step_up_event_id"   text NOT NULL,
  "applied_at"         timestamptz NOT NULL,
  CONSTRAINT "grid_bot_withdrawals_key_ck" CHECK ("withdrawal_key" = 'bots.grid.withdraw:' || "bot_id" || ':' || "request_id"),
  CONSTRAINT "grid_bot_withdrawals_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "grid_bot_withdrawals_profit_ck" CHECK ("profit_after" >= 0 AND "profit_before" = "profit_after" + "amount"),
  CONSTRAINT "grid_bot_withdrawals_reserve_ck" CHECK ("reserve_after" > 0 AND "reserve_before" = "reserve_after" + "amount"),
  CONSTRAINT "grid_bot_withdrawals_cap_ck" CHECK ("cap_remaining" >= 0 AND "cap_withdrawn_today" + "cap_remaining" = "daily_cap")
);

CREATE INDEX IF NOT EXISTS "grid_bot_withdrawals_day_idx" ON "trade"."grid_bot_withdrawals" ("user_id", "asset", "applied_at");
