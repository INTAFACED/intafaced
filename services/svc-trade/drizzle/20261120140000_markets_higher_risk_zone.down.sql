ALTER TABLE trade.markets DROP CONSTRAINT IF EXISTS markets_zone_order_cap_ck, DROP CONSTRAINT IF EXISTS markets_zone_ck;
ALTER TABLE trade.markets DROP COLUMN IF EXISTS zone_order_cap, DROP COLUMN IF EXISTS zone;
