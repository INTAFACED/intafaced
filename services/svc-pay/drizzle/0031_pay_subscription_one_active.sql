-- svc-pay · one mandate has one active subscription, and a create key is unique.
-- Reversal: 0031_pay_subscription_one_active.down.sql
--
-- 0010 stores many subscriptions against one mandate. The double-fire guard is
-- only unique (subscription_id, occurrence) on executions, so two active
-- subscription rows for the same mandate can each settle occurrence N.
-- subscriptions has no idempotency key, so a retried create inserts a second
-- schedule. This file does not add an upsert. The execution unique stays.
--
-- idempotency_key is text NOT NULL. A blank or space-only key is refused by
-- CHECK (length(btrim(idempotency_key)) > 0). UNIQUE (idempotency_key) refuses
-- a second insert of the same key. A partial unique index on mandate_id
-- WHERE status = 'active' refuses a second active row. A cancelled or paused
-- row may sit beside the one active row.
--
-- No default and no backfill. This file does not rewrite stored rows. If a
-- stored subscription exists, ADD COLUMN fails and that row stays. It does not
-- invent a customer, a merchant, or an amount. It does not move value. 0010
-- is already applied.

ALTER TABLE "pay"."subscriptions"
  ADD COLUMN "idempotency_key" text NOT NULL
  CONSTRAINT "subscriptions_idempotency_key_not_blank"
  CHECK (length(btrim("idempotency_key")) > 0);

ALTER TABLE "pay"."subscriptions"
  ADD CONSTRAINT "subscriptions_idempotency_key_uq"
  UNIQUE ("idempotency_key");

CREATE UNIQUE INDEX "subscriptions_one_active_mandate_idx"
  ON "pay"."subscriptions" ("mandate_id")
  WHERE "status" = 'active';
