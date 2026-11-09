-- Reverses the paper runs migration (AL-live-01). Every paper run's settings are lost; a run row of kind 'paper' must be
-- gone before the kind check narrows again, so this refuses while one exists.
DROP TRIGGER IF EXISTS "paper_runs_insert_only" ON "quant"."paper_runs";
DROP FUNCTION IF EXISTS "quant"."reject_paper_run_rewrite"();
DROP TABLE IF EXISTS "quant"."paper_runs";
ALTER TABLE "quant"."runs" DROP CONSTRAINT IF EXISTS "runs_kind_ck";
ALTER TABLE "quant"."runs" ADD CONSTRAINT "runs_kind_ck" CHECK ("kind" IN ('backtest', 'sandbox'));
