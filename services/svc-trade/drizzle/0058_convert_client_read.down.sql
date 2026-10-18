DROP INDEX IF EXISTS "trade"."convert_quotes_user_client_idx";
ALTER TABLE "trade"."convert_quotes" DROP COLUMN IF EXISTS "refusal_code";
ALTER TABLE "trade"."convert_quotes" DROP COLUMN IF EXISTS "client_convert_id";
