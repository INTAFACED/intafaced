-- svc-notify · C-alerts-scan-02 alert manager: stop and resume, and when an alert last changed
-- Reversal: 0020_notify_alert_stopped.down.sql
--
-- status gains 'stopped' (paused by the person, resumable). updated_at is when the person last changed the alert (edit, stop,
-- resume, cancel); existing rows take their creation time.

ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz;
UPDATE "notify"."price_alerts" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "notify"."price_alerts" ALTER COLUMN "updated_at" SET NOT NULL;
ALTER TABLE "notify"."price_alerts" ALTER COLUMN "updated_at" SET DEFAULT now();

ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_status_ck";
ALTER TABLE "notify"."price_alerts" ADD CONSTRAINT "price_alerts_status_ck"
  CHECK ("status" IN ('active', 'fired', 'cancelled', 'expired', 'stopped'));

DROP INDEX IF EXISTS "notify"."price_alerts_expiry_active_idx";
CREATE INDEX IF NOT EXISTS "price_alerts_expiry_active_idx"
  ON "notify"."price_alerts" ("expires_at")
  WHERE "status" IN ('active', 'stopped') AND "expires_at" IS NOT NULL;
