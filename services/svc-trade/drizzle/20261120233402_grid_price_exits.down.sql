-- intafaced:destructive — reversal of 20261120233402_grid_price_exits.sql. A bot's stop prices go with it; a bot
-- already stopped by one keeps its status and reason. They are prices, not money, and nothing else reads them.
ALTER TABLE "trade"."grid_bots" DROP CONSTRAINT IF EXISTS "grid_bots_exits_ck";
ALTER TABLE "trade"."grid_bots" DROP COLUMN IF EXISTS "exit_above";
ALTER TABLE "trade"."grid_bots" DROP COLUMN IF EXISTS "exit_below";
