-- intafaced:destructive — reversal of 20261112124542_certificate_designs.sql
DROP TABLE IF EXISTS "academy"."cert_issued_exports";
ALTER TABLE "academy"."cert_grants" DROP COLUMN IF EXISTS "design_revision";
DROP TABLE IF EXISTS "academy"."cert_designs";
DROP TABLE IF EXISTS "academy"."cert_design_revisions";
