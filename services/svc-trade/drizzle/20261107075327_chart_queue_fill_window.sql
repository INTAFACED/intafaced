-- Charts module owner value: the fill chance window (J-charts-desk-14 #8, RC-charts-desk-01). Blank is NULL: "not set",
-- never a default number. In seconds: a resting order's estimated chance to fill is the base traded at or through its
-- price over this window, over the size that must trade first. While it is blank, the queue read shows the place in the
-- queue and refuses the chance with `trade.queue_probability_unset`. Scalars stay one append-only snapshot per version.
-- Reversal: 20261107075327_chart_queue_fill_window.down.sql
ALTER TABLE trade.chart_owner_values
  ADD COLUMN IF NOT EXISTS queue_fill_window_seconds integer
    CHECK (queue_fill_window_seconds IS NULL OR queue_fill_window_seconds BETWEEN 1 AND 86400);
