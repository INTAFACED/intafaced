-- svc-agents · how a sealed usage window was paid (J-agents-01; launch money model, OWNER 226)
-- Reversal: 20261115020000_usage_window_payment.down.sql
--
-- At launch a window is earned in the ledger as owed by the person and collected from their payment method by their
-- partner. `paid_by` says which path settled it: `ledger` (the custodial layer's fee charge, as before) or `partner`.
-- `payment_ref` is the partner's own id for the payment, the outside fact the ledger's collect is keyed on;
-- `payment_label` is the partner's name for itself. Null on a window not yet paid, and on windows paid before this
-- column (all of them on the ledger). Nothing here is a balance and no value moves.

ALTER TABLE "agents"."usage_windows" ADD COLUMN IF NOT EXISTS "paid_by" text;
ALTER TABLE "agents"."usage_windows" ADD COLUMN IF NOT EXISTS "payment_ref" text;
ALTER TABLE "agents"."usage_windows" ADD COLUMN IF NOT EXISTS "payment_label" text;
ALTER TABLE "agents"."usage_windows" DROP CONSTRAINT IF EXISTS "usage_windows_paid_by_ck";
ALTER TABLE "agents"."usage_windows"
  ADD CONSTRAINT "usage_windows_paid_by_ck" CHECK (
    "paid_by" IS NULL OR ("paid_by" = 'ledger' AND "payment_ref" IS NULL) OR ("paid_by" = 'partner' AND "payment_ref" IS NOT NULL)
  );
