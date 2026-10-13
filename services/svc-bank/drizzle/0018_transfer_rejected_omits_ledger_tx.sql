-- A rejected firing must not point at a ledger posting.
--
-- `transfer_executions_rejected_has_code_ck` requires a rejection code and
-- says nothing about `ledger_tx_id`. A rejected row can still name the
-- transaction that moved the value, which is a claim that the firing both
-- happened and did not.
--
-- CHECK only. No UPDATE and no DELETE of money rows. If a book already holds
-- a violating row, ADD CONSTRAINT fails and the amounts stay.
--
-- Reversal: 0018_transfer_rejected_omits_ledger_tx.down.sql

ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_rejected_omits_ledger_tx_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_rejected_omits_ledger_tx_ck"
  CHECK ("status" <> 'rejected' OR "ledger_tx_id" IS NULL);
