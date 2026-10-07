-- intafaced:destructive — reversal of 0022_org_roles.sql
--
-- admin → owner; trader/auditor → member. Restores owner/member CHECK.
-- Drop the live admin/trader/auditor CHECK first. owner and member are illegal
-- while that CHECK is still present.

ALTER TABLE "identity"."organization_members" DROP CONSTRAINT IF EXISTS "organization_members_role_ck";

UPDATE "identity"."organization_members" SET "role" = 'owner' WHERE "role" = 'admin';
UPDATE "identity"."organization_members" SET "role" = 'member' WHERE "role" IN ('trader', 'auditor');

ALTER TABLE "identity"."organization_members" ADD CONSTRAINT "organization_members_role_ck"
  CHECK ("role" IN ('owner', 'member'));
