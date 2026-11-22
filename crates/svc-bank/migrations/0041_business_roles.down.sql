-- Remove the five roles added by 0041. PostgreSQL cannot DROP VALUE, so recreate the
-- 0011 type. A member or a member command still holding a new role makes the cast fail
-- and this script rolls back: re-role those members first.

ALTER TYPE "bank"."business_member_role" RENAME TO "business_member_role_old";

CREATE TYPE "bank"."business_member_role" AS ENUM ('admin', 'maker', 'checker');

ALTER TABLE "bank"."business_members"
  ALTER COLUMN "role" TYPE "bank"."business_member_role"
  USING "role"::text::"bank"."business_member_role";

ALTER TABLE "bank"."business_member_commands"
  ALTER COLUMN "role" TYPE "bank"."business_member_role"
  USING "role"::text::"bank"."business_member_role";

DROP TYPE "bank"."business_member_role_old";
