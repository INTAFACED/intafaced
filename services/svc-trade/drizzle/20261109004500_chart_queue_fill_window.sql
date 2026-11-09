-- Charts module owner value: the queue fill window (J-charts-desk-14 #8, RC-charts-desk-01). Blank is NULL: "not set",
-- never a default number. In seconds: a resting order's estimated chance of a fill is read from the volume traded at or
-- through its price over this window, set against the size queued ahead of it and its own remaining size. While it is
-- blank, the queue read answers the position only, with the typed reason trade.queue_probability_unset and no percent.
-- Scalars stay one append-only snapshot per version (0098).
-- Reversal: 20261109004500_chart_queue_fill_window.down.sql
ALTER TABLE trade.chart_owner_values
  ADD COLUMN IF NOT EXISTS queue_fill_window_seconds integer
    CHECK (queue_fill_window_seconds IS NULL OR queue_fill_window_seconds BETWEEN 1 AND 86400);
