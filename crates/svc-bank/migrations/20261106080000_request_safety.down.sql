DROP TABLE IF EXISTS "bank"."personal_request_blocks";
DROP TABLE IF EXISTS "bank"."personal_request_reports";
ALTER TABLE "bank"."personal_request_reminds" DROP COLUMN IF EXISTS "created_at";
