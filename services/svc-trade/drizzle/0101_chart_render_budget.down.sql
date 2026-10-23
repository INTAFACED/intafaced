-- intafaced:destructive — reversal of 0101_chart_render_budget.sql
-- Drops the render budget column. Only the budget values are lost; the other charts owner values are untouched.
ALTER TABLE trade.chart_owner_values DROP COLUMN IF EXISTS render_budget_ms;
