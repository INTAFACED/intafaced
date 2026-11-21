-- Reverses 20261112151032_grid_top_ups.sql.
DROP TABLE IF EXISTS "trade"."grid_bot_top_ups";
ALTER TABLE "trade"."grid_bots" DROP COLUMN IF EXISTS "reinit_count";
