-- svc-identity · Why a key was revoked (DV-keys-03, J-developer-03 #1). Each writer that revokes a key now records when
-- and why: the person (owner, with the reason they typed, if any), another key or sub-account of the account
-- (delegate), an account freeze, an operator's revoke of one key, an account closure, our team during an account
-- recovery (support), or the service undoing a key it never handed over (system). A key revoked before this migration
-- keeps null and the list says the reason was not recorded, except a key an operator revoked
-- (api_key_operator_revocations, 0063), which is filled in below.
-- An operator's own note stays in 0063 and is never copied here: revoke_reason holds only the person's own words.
-- Reversal: the .down.sql of the same name.

-- api_keys is read on every key exchange: wait at most five seconds for its lock rather than queue behind a long
-- transaction and stall every exchange behind this migration.
SET lock_timeout = '5s';

ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;
ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "revoked_cause" text;
ALTER TABLE "identity"."api_keys" ADD COLUMN IF NOT EXISTS "revoke_reason" text;

-- NOT VALID: every row before this migration has the three columns null, which each check accepts; the checks are
-- validated below under the weaker lock, after the backfill.
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoked_cause_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_revoked_cause_ck"
  CHECK ("revoked_cause" IS NULL OR "revoked_cause" IN ('owner', 'delegate', 'account_freeze', 'operator', 'account_closed', 'support', 'system')) NOT VALID;
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoke_reason_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_revoke_reason_ck"
  CHECK ("revoke_reason" IS NULL OR (char_length(btrim("revoke_reason")) BETWEEN 1 AND 200 AND "revoked_cause" = 'owner')) NOT VALID;
-- A time, a cause or a reason only on a revoked key.
ALTER TABLE "identity"."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoked_fields_ck";
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_revoked_fields_ck"
  CHECK ("revoked" OR ("revoked_at" IS NULL AND "revoked_cause" IS NULL AND "revoke_reason" IS NULL)) NOT VALID;

UPDATE "identity"."api_keys" k
SET "revoked_cause" = 'operator', "revoked_at" = r."revoked_at"
FROM "identity"."api_key_operator_revocations" r
WHERE r."key_id" = k."id" AND k."revoked" AND k."revoked_cause" IS NULL;

ALTER TABLE "identity"."api_keys" VALIDATE CONSTRAINT "api_keys_revoked_cause_ck";
ALTER TABLE "identity"."api_keys" VALIDATE CONSTRAINT "api_keys_revoke_reason_ck";
ALTER TABLE "identity"."api_keys" VALIDATE CONSTRAINT "api_keys_revoked_fields_ck";

-- Later statements on this connection keep their own lock wait.
RESET lock_timeout;
