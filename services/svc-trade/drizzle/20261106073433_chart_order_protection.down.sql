-- intafaced:destructive — reversal of 20261106073433_chart_order_protection.sql drops the chart's order protection
-- distance. No money is in it: a blank value already refuses a chart drag, so the chart refuses again after the drop.
ALTER TABLE trade.chart_owner_values DROP COLUMN IF EXISTS order_protection_bps;
