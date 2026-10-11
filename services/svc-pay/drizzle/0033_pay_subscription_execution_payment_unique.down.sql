-- intafaced:destructive — reversal of 0033_pay_subscription_execution_payment_unique.sql
--
-- Drops only the two unique indexes that stop one payment_id or one
-- ledger_tx_id from settling a second execution. The unique
-- (subscription_id, occurrence) stays. The non-unique payment lookup index
-- stays. Stored rows stay. This reversal moves no value.

DROP INDEX IF EXISTS "pay"."subscription_executions_ledger_tx_id_uq";
DROP INDEX IF EXISTS "pay"."subscription_executions_payment_id_uq";
