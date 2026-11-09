-- intafaced:destructive — reversal of 20261109004500_chart_queue_fill_window.sql drops the queue fill window. No money is
-- in it: a blank window already answers the queue position without an estimate, so the read does that again after the drop.
ALTER TABLE trade.chart_owner_values DROP COLUMN IF EXISTS queue_fill_window_seconds;
