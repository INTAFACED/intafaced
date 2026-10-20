-- Reverses 0055_session_families.sql. Sessions keep working; they lose their family grouping and device detail.
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "country";
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "user_agent";
ALTER TABLE "identity"."sessions" DROP COLUMN IF EXISTS "family_id";
