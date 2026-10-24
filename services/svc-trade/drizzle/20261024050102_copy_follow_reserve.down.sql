-- intafaced:destructive — reversal of 20261024050102_copy_follow_reserve.sql
DROP TABLE IF EXISTS "trade"."copy_follow_reserves";

ALTER TABLE "trade"."copy_follows"
  DROP CONSTRAINT IF EXISTS "copy_follows_fixed_order_size_ck";

ALTER TABLE "trade"."copy_follows"
  DROP COLUMN IF EXISTS "fixed_order_size";
