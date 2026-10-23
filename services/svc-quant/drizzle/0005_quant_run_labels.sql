-- svc-quant · run labels (AL-backtest-03)
-- Reversal: 0005_quant_run_labels.down.sql
--
-- No money, no balance, no ledger post. A label is the person's own name for one of their runs. It lives beside the
-- run, never in it: quant.runs stays write-once (reject_run_rewrite), so renaming can never change a stored result.

CREATE TABLE IF NOT EXISTS "quant"."run_labels" (
  "run_id"      text PRIMARY KEY REFERENCES "quant"."runs"("id"),
  "user_id"     uuid NOT NULL,
  "label"       text NOT NULL,
  "updated_at"  timestamptz NOT NULL,
  CONSTRAINT "run_labels_label_ck" CHECK (char_length("label") BETWEEN 1 AND 80)
);
