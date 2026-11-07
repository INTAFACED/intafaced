-- intafaced:destructive — reversal of 20261107075327_chart_queue_fill_window.sql drops the fill chance window. No money is
-- in it: a blank window already refuses the estimate, so the queue read refuses the chance again after the drop.
ALTER TABLE trade.chart_owner_values DROP COLUMN IF EXISTS queue_fill_window_seconds;
