-- Reverses 20261115020000_usage_window_payment.sql.
ALTER TABLE "agents"."usage_windows" DROP CONSTRAINT IF EXISTS "usage_windows_paid_by_ck";
ALTER TABLE "agents"."usage_windows" DROP COLUMN IF EXISTS "payment_label";
ALTER TABLE "agents"."usage_windows" DROP COLUMN IF EXISTS "payment_ref";
ALTER TABLE "agents"."usage_windows" DROP COLUMN IF EXISTS "paid_by";
