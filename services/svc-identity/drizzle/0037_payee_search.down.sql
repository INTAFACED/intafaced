DROP TABLE IF EXISTS "identity"."payee_search_audit";
DROP INDEX IF EXISTS "identity"."users_phone_idx";
ALTER TABLE "identity"."users" DROP CONSTRAINT IF EXISTS "users_phone_e164_ck";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "payee_phone_consent";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "payee_email_consent";
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "phone";
