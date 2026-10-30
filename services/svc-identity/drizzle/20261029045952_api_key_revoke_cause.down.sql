-- Reverses 20261029045952_api_key_revoke_cause.sql.
-- intafaced:destructive drops when and why each key was revoked; the keys and their revoked flag stay, and operator
-- revokes keep their own record in api_key_operator_revocations.
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoked_fields_ck";
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoke_reason_ck";
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoked_cause_ck";
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "revoke_reason";
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "revoked_cause";
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "revoked_at";
