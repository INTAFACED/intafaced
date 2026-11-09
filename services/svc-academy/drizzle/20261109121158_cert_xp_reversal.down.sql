-- intafaced:destructive — reversal of 20261109121158_cert_xp_reversal.sql
DROP INDEX IF EXISTS "academy"."cert_revocations_xp_unsettled_idx";
ALTER TABLE "academy"."cert_revocations" DROP CONSTRAINT IF EXISTS "cert_revocations_xp_settled_chk";
ALTER TABLE "academy"."cert_revocations" DROP COLUMN IF EXISTS "xp_settled_at";
ALTER TABLE "academy"."cert_revocations" DROP COLUMN IF EXISTS "xp_settled";
ALTER TABLE "academy"."cert_grants" DROP CONSTRAINT IF EXISTS "cert_grants_xp_awarded_chk";
ALTER TABLE "academy"."cert_grants" DROP COLUMN IF EXISTS "xp_awarded";
