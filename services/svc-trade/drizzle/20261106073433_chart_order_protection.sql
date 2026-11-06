-- Charts module owner value: the order protection distance (J-charts-desk-15 #5). Blank is NULL: "not set", never a
-- default number. In basis points of the market's last price: a chart order dragged to a price further than this from
-- the last trade asks the person to confirm, naming the distance, before anything is sent. While it is blank, a drag
-- on the chart refuses with the typed owner-value reason. Scalars stay one append-only snapshot per version (0098).
-- Reversal: 20261106073433_chart_order_protection.down.sql
ALTER TABLE trade.chart_owner_values
  ADD COLUMN IF NOT EXISTS order_protection_bps integer
    CHECK (order_protection_bps IS NULL OR order_protection_bps BETWEEN 1 AND 10000);
