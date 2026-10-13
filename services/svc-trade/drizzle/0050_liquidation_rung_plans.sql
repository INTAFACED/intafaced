-- trade.futures · liquidation rung plans
-- Reversal: 0050_liquidation_rung_plans.down.sql
--
-- What a liquidation rung COMMITTED to before its first ledger post: the
-- recipes (amounts as decimal strings), the size closed and the margin left.
-- A replay after a crash re-posts this plan instead of re-planning at a new
-- mark, so one idempotency key never carries two sets of amounts.
--
-- "completed_at" is set once the position row has moved by the plan. A
-- completed plan is history: it is never loaded for replay, and the next plan
-- under the same key (the row regrew to an earlier size) replaces it.
--
-- Plan IDENTITY only — never a balance. The ledger remains the only book of money.

CREATE TABLE IF NOT EXISTS "trade"."liquidation_rung_plans" (
  "rung_key"     text PRIMARY KEY,
  "plan"         jsonb NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
