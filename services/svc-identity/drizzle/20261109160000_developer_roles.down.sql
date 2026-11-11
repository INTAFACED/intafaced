-- intafaced:destructive — reverses 20261109160000_developer_roles.sql.
DROP TABLE IF EXISTS "identity"."org_developer_role_changes";
DROP TABLE IF EXISTS "identity"."org_developer_roles";
DROP INDEX IF EXISTS "identity"."api_keys_org_idx";
ALTER TABLE "identity"."api_keys" DROP COLUMN IF EXISTS "org_id";
