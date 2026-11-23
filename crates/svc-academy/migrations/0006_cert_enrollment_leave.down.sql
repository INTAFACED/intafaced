-- Reverse 0006. Drops left history so the original (user, path) key can return.
DELETE FROM "academy"."cert_enrollments" WHERE "left_at" IS NOT NULL;

ALTER TABLE "academy"."cert_enrollments" DROP CONSTRAINT IF EXISTS "cert_enrollments_pkey";
DROP INDEX IF EXISTS "academy"."cert_enrollments_active_uq";
DROP INDEX IF EXISTS "academy"."cert_enrollments_leave_request_uq";

ALTER TABLE "academy"."cert_enrollments" DROP COLUMN IF EXISTS "id";
ALTER TABLE "academy"."cert_enrollments" DROP COLUMN IF EXISTS "left_at";
ALTER TABLE "academy"."cert_enrollments" DROP COLUMN IF EXISTS "leave_request_id";

ALTER TABLE "academy"."cert_enrollments" ADD PRIMARY KEY ("user_id", "path_slug");
