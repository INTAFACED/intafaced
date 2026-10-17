DROP TABLE IF EXISTS "pay"."merchant_webhook_rotations";
DROP TABLE IF EXISTS "pay"."merchant_webhook_retries";

ALTER TABLE "pay"."merchant_export_jobs" DROP COLUMN IF EXISTS "columns";
ALTER TABLE "pay"."merchant_export_jobs" DROP COLUMN IF EXISTS "generated_at";

UPDATE "pay"."merchant_export_jobs" SET "status" = 'failed' WHERE "status" = 'expired';
DELETE FROM "pay"."merchant_export_jobs"
 WHERE "kind" NOT IN ('payments', 'settlements', 'payouts');

ALTER TABLE "pay"."merchant_export_jobs" DROP CONSTRAINT IF EXISTS "merchant_export_jobs_status_ck";
ALTER TABLE "pay"."merchant_export_jobs" ADD CONSTRAINT "merchant_export_jobs_status_ck"
  CHECK ("status" IN ('queued', 'running', 'ready', 'failed'));

ALTER TABLE "pay"."merchant_export_jobs" DROP CONSTRAINT IF EXISTS "merchant_export_jobs_kind_ck";
ALTER TABLE "pay"."merchant_export_jobs" ADD CONSTRAINT "merchant_export_jobs_kind_ck"
  CHECK ("kind" IN ('payments', 'settlements', 'payouts'));
