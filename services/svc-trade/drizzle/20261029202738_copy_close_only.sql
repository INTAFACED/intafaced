-- trade.copy · stop with close-only (CB-copy-09)
-- Reversal: 20261029202738_copy_close_only.down.sql
--
-- CLOSE_ONLY: a stopped follow that takes no new opens while the leader's
-- closes still close the follower's copied positions. ACTIVE and PAUSED can
-- move to it; it moves on to DETACHED like STOPPING does.

ALTER TABLE "trade"."copy_follows"
  DROP CONSTRAINT IF EXISTS "copy_follows_relationship_state_ck";

ALTER TABLE "trade"."copy_follows"
  ADD CONSTRAINT "copy_follows_relationship_state_ck"
  CHECK ("relationship_state" IN ('ACTIVE', 'PAUSED', 'STOPPING', 'CLOSE_ONLY', 'DETACHED'));

-- trade.copy_close_orders: a follower's close of one copied position (CB-copy-10).
-- One row per close key, written before the sell is placed. A row whose order
-- is not on the book yet reads as closing (outcome unknown); a retry reuses the
-- key, the order's client id and its price, so a close is placed at most once
-- per key and a retry sends the same order.
CREATE TABLE IF NOT EXISTS "trade"."copy_close_orders" (
  "close_key" text PRIMARY KEY,
  "follow_id" text NOT NULL,
  "leader_fill_id" text NOT NULL,
  "follower_order_id" text NOT NULL,
  "client_order_id" text NOT NULL,
  "qty" numeric(38, 18) NOT NULL CHECK ("qty" > 0),
  "price" numeric(38, 18) NOT NULL CHECK ("price" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "copy_close_orders_follow_idx" ON "trade"."copy_close_orders" ("follow_id");
