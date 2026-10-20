-- svc-notify · C-alerts-scan-01 price alert conditions, expiry, name and message
-- Reversal: 0018_notify_alert_conditions.down.sql
--
-- condition: how the mark is compared with the target. Existing rows were levels (above / below), so they become
-- greater_than / less_than and behave exactly as before. last_side is the side a crossing watch was last seen on (NULL until
-- the sweep has seen it once). expires_at is open-ended when NULL. name and message are the person's own words.

ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "condition" text;
UPDATE "notify"."price_alerts"
  SET "condition" = CASE "direction" WHEN 'below' THEN 'less_than' ELSE 'greater_than' END
  WHERE "condition" IS NULL;
ALTER TABLE "notify"."price_alerts" ALTER COLUMN "condition" SET NOT NULL;
ALTER TABLE "notify"."price_alerts" ALTER COLUMN "condition" SET DEFAULT 'greater_than';
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "message" text;
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
ALTER TABLE "notify"."price_alerts" ADD COLUMN IF NOT EXISTS "last_side" text;

ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_condition_ck";
ALTER TABLE "notify"."price_alerts" ADD CONSTRAINT "price_alerts_condition_ck"
  CHECK ("condition" IN ('crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than'));
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_last_side_ck";
ALTER TABLE "notify"."price_alerts" ADD CONSTRAINT "price_alerts_last_side_ck"
  CHECK ("last_side" IS NULL OR "last_side" IN ('below', 'at_or_above'));
ALTER TABLE "notify"."price_alerts" DROP CONSTRAINT IF EXISTS "price_alerts_status_ck";
ALTER TABLE "notify"."price_alerts" ADD CONSTRAINT "price_alerts_status_ck"
  CHECK ("status" IN ('active', 'fired', 'cancelled', 'expired'));

CREATE INDEX IF NOT EXISTS "price_alerts_expiry_active_idx"
  ON "notify"."price_alerts" ("expires_at")
  WHERE "status" = 'active' AND "expires_at" IS NOT NULL;
