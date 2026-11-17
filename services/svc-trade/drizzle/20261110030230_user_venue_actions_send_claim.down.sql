DROP INDEX IF EXISTS trade.user_venue_actions_orders_idx;
ALTER TABLE trade.user_venue_actions DROP COLUMN IF EXISTS sending_until;
