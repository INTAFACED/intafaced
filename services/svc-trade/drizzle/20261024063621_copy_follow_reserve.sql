-- trade.copy · fixed amount per copied order and the per-follow reserve (CB-copy-03, CB-copy-04; J-copy-bots-otc-01 #7)
-- Reversal: 20261024063621_copy_follow_reserve.down.sql
--
-- fixed_order_size: the quote amount each copied order uses. NULL means the follower chose no fixed size; it is never
-- defaulted. It can never exceed max_notional_per_order.
--
-- copy_follow_reserves: how much of the follower's own spot balance this follow may use, shown as used and left. It is
-- a svc-trade limit row, not a balance and not a ledger hold: nothing posts when it is written or released, and each
-- copied order still takes its own order hold. Business key copy.reserve:<follow_id>. Released when the follow is
-- detached or removed; the row stays as the record.

ALTER TABLE "trade"."copy_follows"
  ADD COLUMN IF NOT EXISTS "fixed_order_size" numeric(38, 18);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'copy_follows_fixed_order_size_ck') THEN
    ALTER TABLE "trade"."copy_follows"
      ADD CONSTRAINT "copy_follows_fixed_order_size_ck"
      CHECK ("fixed_order_size" IS NULL OR ("fixed_order_size" > 0 AND "fixed_order_size" <= "max_notional_per_order"));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "trade"."copy_follow_reserves" (
  "reserve_key"  text PRIMARY KEY,
  "follow_id"    text NOT NULL UNIQUE,
  "follower_id"  text NOT NULL,
  "asset"        text NOT NULL,
  "amount"       numeric(38, 18) NOT NULL,
  "held_at"      timestamptz NOT NULL,
  "released_at"  timestamptz,
  CONSTRAINT "copy_follow_reserves_key_ck" CHECK ("reserve_key" = 'copy.reserve:' || "follow_id"),
  CONSTRAINT "copy_follow_reserves_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "copy_follow_reserves_release_ck" CHECK ("released_at" IS NULL OR "released_at" >= "held_at")
);

CREATE INDEX IF NOT EXISTS "copy_follow_reserves_held_idx"
  ON "trade"."copy_follow_reserves" ("follower_id", "asset")
  WHERE "released_at" IS NULL;
