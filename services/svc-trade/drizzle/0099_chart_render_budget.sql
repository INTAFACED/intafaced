-- Charts module owner value: the render budget (J-charts-desk-02 #6). Blank is NULL: "not set", never a default number.
-- The longest single main-thread task, in milliseconds, that the chart may hold while ticks stream. The customer app
-- refuses to judge the budget while it is unset. Scalars stay one append-only snapshot per version (0098).
-- Reversal: 0099_chart_render_budget.down.sql
ALTER TABLE trade.chart_owner_values
  ADD COLUMN IF NOT EXISTS render_budget_ms integer CHECK (render_budget_ms IS NULL OR render_budget_ms BETWEEN 1 AND 60000);
