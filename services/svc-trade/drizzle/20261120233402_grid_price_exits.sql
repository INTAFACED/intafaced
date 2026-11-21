-- trade.grid_bots price exits · a running grid's own stop prices (CB-bots-03; J-copy-bots-otc-15 #3)
-- Reversal: 20261120233402_grid_price_exits.down.sql
--
-- A grid may carry a price at which it stops: when the best bid falls to exit_below, or the best ask rises to
-- exit_above. The tick that sees it stops the bot once, with status_reason 'price_exit', by the same conditional status
-- write every stop uses, then winds it down. Blank (NULL) is no exit. The columns hold prices, not money: nothing posts.

ALTER TABLE "trade"."grid_bots" ADD COLUMN IF NOT EXISTS "exit_below" numeric(38, 18);
ALTER TABLE "trade"."grid_bots" ADD COLUMN IF NOT EXISTS "exit_above" numeric(38, 18);
ALTER TABLE "trade"."grid_bots" DROP CONSTRAINT IF EXISTS "grid_bots_exits_ck";
ALTER TABLE "trade"."grid_bots" ADD CONSTRAINT "grid_bots_exits_ck" CHECK (
  ("exit_below" IS NULL OR "exit_below" > 0)
  AND ("exit_above" IS NULL OR "exit_above" > 0)
  AND ("exit_below" IS NULL OR "exit_above" IS NULL OR "exit_below" < "exit_above")
);
