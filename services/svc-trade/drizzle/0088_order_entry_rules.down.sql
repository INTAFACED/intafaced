DROP TABLE IF EXISTS trade.account_price_correction;
ALTER TABLE trade.orders DROP COLUMN IF EXISTS requested_price;
