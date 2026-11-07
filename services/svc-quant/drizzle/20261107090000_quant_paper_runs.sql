-- svc-quant · paper runs on the exchange's own prices (AL-live-01)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. A paper run is a run row of kind 'paper' that stays open (finished_at NULL)
-- while it runs; stopping it finishes the row once, with outcome 'stopped', and keeps the record. Its starting cash,
-- holdings, data feed and costs are kept beside it here, insert-only. Fills, positions and equity are never stored:
-- they are derived on every read from the exchange's own closed candles between the start and now, or the stop.

ALTER TABLE "quant"."runs" DROP CONSTRAINT IF EXISTS "runs_kind_ck";
ALTER TABLE "quant"."runs" ADD CONSTRAINT "runs_kind_ck" CHECK ("kind" IN ('backtest', 'sandbox', 'paper'));

CREATE TABLE IF NOT EXISTS "quant"."paper_runs" (
  "run_id" text PRIMARY KEY REFERENCES "quant"."runs"("id"),
  "account_id" uuid NOT NULL,
  "strategy_id" text NOT NULL,
  "strategy_version" integer NOT NULL CHECK ("strategy_version" >= 1),
  "cash" text NOT NULL CHECK ("cash" ~ '^\d{1,18}(\.\d{1,18})?$'),
  "holdings" jsonb NOT NULL,
  "feed" text NOT NULL CHECK ("feed" = 'own_venue'),
  "fee_role" text NOT NULL CHECK ("fee_role" IN ('taker', 'maker')),
  "slippage_bps" text NOT NULL,
  "delay_bars" integer NOT NULL CHECK ("delay_bars" BETWEEN 0 AND 100),
  "started_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "paper_runs_account_idx" ON "quant"."paper_runs" ("account_id", "strategy_id", "started_at");

CREATE OR REPLACE FUNCTION "quant"."reject_paper_run_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.run_immutable — paper run % cannot be rewritten', OLD.run_id;
END;
$$;

DROP TRIGGER IF EXISTS "paper_runs_insert_only" ON "quant"."paper_runs";
CREATE TRIGGER "paper_runs_insert_only"
  BEFORE UPDATE OR DELETE ON "quant"."paper_runs"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_paper_run_rewrite"();
