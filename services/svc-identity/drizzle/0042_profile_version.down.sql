-- intafaced:destructive — reversal of 0042_profile_version.sql.
DROP TABLE IF EXISTS "identity"."profile_audit";
ALTER TABLE "identity"."profiles" DROP COLUMN IF EXISTS "version";
