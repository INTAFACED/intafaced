-- Reversal of 0018_notify_alert_conditions.sql. Expired watches go back to cancelled (the nearest state the old code knows).
DROP INDEX IF EXISTS "notify"."price_alerts_expiry_active_idx";
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_status_ck";
UPDATE "notify"."price_alerts" SET "status" = 'cancelled' WHERE "status" = 'expired';
ALTER TABLE "notify"."price_alerts" ADD CONSTRAINT "price_alerts_status_ck"
  CHECK ("status" IN ('active', 'fired', 'cancelled'));
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_last_side_ck";
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_condition_ck";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "last_side";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "expires_at";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "message";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "name";
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "condition";
