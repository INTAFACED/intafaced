-- svc-identity · Why a key was revoked (DV-keys-03, J-developer-03 #1). Each writer that revokes a key now records when
-- and why: the person (owner, with the reason they typed, if any), an account freeze, an operator's revoke of one key,
-- or an account closure. A key revoked before this migration keeps null and the list says the reason was not
-- recorded, except a key an operator revoked (api_key_operator_revocations, 0063), which is filled in below.
-- An operator's own note stays in 0063 and is never copied here: revoke_reason holds only the person's own words.
-- Reversal: the .down.sql of the same name.
ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;
ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "revoked_cause" text;
ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "revoke_reason" text;

ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoked_cause_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_revoked_cause_ck"
  CHECK ("revoked_cause" IS NULL OR "revoked_cause" IN ('owner', 'account_freeze', 'operator', 'account_closed'));
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoke_reason_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_revoke_reason_ck"
  CHECK ("revoke_reason" IS NULL OR (char_length(btrim("revoke_reason")) BETWEEN 1 AND 200 AND "revoked_cause" = 'owner'));
-- A time, a cause or a reason only on a revoked key.
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoked_fields_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_revoked_fields_ck"
  CHECK ("revoked" OR ("revoked_at" IS NULL AND "revoked_cause" IS NULL AND "revoke_reason" IS NULL));

UPDATE "identity"."api_keys" k
SET "revoked_cause" = 'operator', "revoked_at" = r."revoked_at"
FROM "identity"."api_key_operator_revocations" r
WHERE r."key_id" = k."id" AND k."revoked" AND k."revoked_cause" IS NULL;
