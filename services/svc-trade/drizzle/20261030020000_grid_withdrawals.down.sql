-- intafaced:destructive — reversal of 20261030020000_grid_withdrawals.sql
DROP TABLE IF EXISTS "trade"."grid_bot_withdrawals";
-- Reserves that grid sells raised by their profit while this migration was up stay raised; they release in full when
-- each bot stops, so nothing is stranded.
