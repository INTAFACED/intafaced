-- intafaced:destructive — reversal of 0107_copy_leader_market_mode.sql
-- Drops the leader market mode; every listing reads as the spot leader it was before.
DROP INDEX IF EXISTS trade.copy_leader_listings_mode_order_idx;
ALTER TABLE trade.copy_leader_listings DROP CONSTRAINT IF EXISTS copy_leader_listings_mode_ck;
ALTER TABLE trade.copy_leader_listings DROP COLUMN IF EXISTS market_mode;
