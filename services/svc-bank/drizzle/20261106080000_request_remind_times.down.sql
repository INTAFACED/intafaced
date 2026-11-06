DROP INDEX IF EXISTS "bank"."personal_request_reminds_time_idx";
ALTER TABLE "bank"."personal_request_reminds" DROP COLUMN IF EXISTS "created_at";
