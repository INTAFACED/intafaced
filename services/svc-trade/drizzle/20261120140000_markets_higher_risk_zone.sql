-- J-cex-spot-14 #7 (SP-markets-data-02): a market may sit in the higher-risk zone. A zone market takes limit orders
-- only, each worth at most its owner-set order cap in the quote asset; with no cap set it takes no order at all
-- (`trade.zone_setting_unset`). A market outside the zone has neither (null).
ALTER TABLE trade.markets
  ADD COLUMN IF NOT EXISTS zone text,
  ADD COLUMN IF NOT EXISTS zone_order_cap numeric(38, 18);
ALTER TABLE trade.markets
  ADD CONSTRAINT markets_zone_ck CHECK (zone IS NULL OR zone = 'higher_risk'),
  ADD CONSTRAINT markets_zone_order_cap_ck CHECK (zone_order_cap IS NULL OR (zone IS NOT NULL AND zone_order_cap > 0));
