-- Charts module owner value: the render budget (J-charts-desk-02 #6). Blank is NULL: "not set", never a default number.
-- The longest single main-thread task, in milliseconds, that the chart may hold while ticks stream. Only the
-- J-charts-desk-02 #6 journey reads it: the chart itself does not judge a budget, so a blank value is a missing owner
-- setting that the journey fails on by name. Scalars stay one append-only snapshot per version (0098).
-- Reversal: 0099_chart_render_budget.down.sql
ALTER TABLE trade.chart_owner_values
  ADD COLUMN IF NOT EXISTS render_budget_ms integer CHECK (render_budget_ms IS NULL OR render_budget_ms BETWEEN 1 AND 60000);
