DROP TABLE IF EXISTS "academy"."cert_holder_name_requests";

ALTER TABLE "academy"."cert_grants" DROP CONSTRAINT IF EXISTS "cert_grants_holder_consent_chk";
ALTER TABLE "academy"."cert_grants" DROP CONSTRAINT IF EXISTS "cert_grants_status_chk";
ALTER TABLE "academy"."cert_grants" DROP CONSTRAINT IF EXISTS "cert_grants_public_id_uq";

ALTER TABLE "academy"."cert_grants" DROP COLUMN IF EXISTS "holder_consent_at";
ALTER TABLE "academy"."cert_grants" DROP COLUMN IF EXISTS "holder_name";
ALTER TABLE "academy"."cert_grants" DROP COLUMN IF EXISTS "status";
ALTER TABLE "academy"."cert_grants" DROP COLUMN IF EXISTS "public_id";
