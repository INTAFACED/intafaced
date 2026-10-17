ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "successor_refresh";
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "successor_id";
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "rotated_at";
