ALTER TABLE trade.markets DROP CONSTRAINT IF EXISTS markets_delists_at_ck;
ALTER TABLE trade.markets DROP COLUMN IF EXISTS delists_at;
