-- intafaced:destructive — reversal of 0005_quant_run_labels.sql
--
-- Drops the run labels. The runs and their results stay as stored; only the names people gave them go.

DROP TABLE IF EXISTS "quant"."run_labels";
