-- svc-pay · one payment and one ledger transaction can settle only one execution.
-- Reversal: 0033_pay_subscription_execution_payment_unique.down.sql
--
-- 0010 stores subscription_executions.payment_id and ledger_tx_id. Unique
-- (subscription_id, occurrence) stops two rows for the same occurrence. It
-- does not stop two occurrences, including on different subscriptions, from
-- storing the same payment_id or the same ledger_tx_id and both being marked
-- settled. The payment lookup index on payment_id is not unique. 0010 is
-- already applied. This file does not edit it.
--
-- A unique index on (payment_id) WHERE payment_id IS NOT NULL refuses a
-- second row that stores that payment. A unique index on (ledger_tx_id)
-- WHERE ledger_tx_id IS NOT NULL refuses a second row that stores that
-- ledger transaction. Multiple NULL payment_id rows stay allowed. Multiple
-- NULL ledger_tx_id rows stay allowed. NULLS NOT DISTINCT is not used.
--
-- The unique (subscription_id, occurrence) stays. The non-unique payment
-- lookup index stays. This file does not drop either. It does not rewrite
-- stored rows. If duplicates already exist, creating the unique index fails
-- and those rows stay. It does not add an upsert or a ledger post. Money
-- stays numeric.

CREATE UNIQUE INDEX "subscription_executions_payment_id_uq"
  ON "pay"."subscription_executions" ("payment_id")
  WHERE "payment_id" IS NOT NULL;

CREATE UNIQUE INDEX "subscription_executions_ledger_tx_id_uq"
  ON "pay"."subscription_executions" ("ledger_tx_id")
  WHERE "ledger_tx_id" IS NOT NULL;
