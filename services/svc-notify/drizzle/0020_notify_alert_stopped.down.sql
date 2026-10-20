-- Reversal of 0020_notify_alert_stopped.sql. Stopped alerts go back to cancelled (the nearest state the old code knows).
DROP INDEX IF EXISTS "notify"."price_alerts_expiry_active_idx";
CREATE INDEX IF NOT EXISTS "price_alerts_expiry_active_idx"
  ON "notify"."price_alerts" ("expires_at")
  WHERE "status" = 'active' AND "expires_at" IS NOT NULL;
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_status_ck";
UPDATE "notify"."price_alerts" SET "status" = 'cancelled' WHERE "status" = 'stopped';
ALTER TABLE "notify"."price_alerts" ADD CONSTRAINT "price_alerts_status_ck"
  CHECK ("status" IN ('active', 'fired', 'cancelled', 'expired'));
ALTER TABLE "notify"."price_alerts" DROP COLUMN IF EXISTS "updated_at";
