-- Reverses 20261115235523_business_team_rules.sql. Refuses, changing nothing, while any payment was sent to the partner:
-- dropping its row would erase the only record of which instruction the partner carried out for the business.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."business_payments" WHERE "partner_move_id" IS NOT NULL OR "status" = 'sending') THEN
    RAISE EXCEPTION 'business_team_rules down: payments were sent to the partner; nothing was changed';
  END IF;
END
$$;

-- intafaced:destructive the team, rules and payment tables this migration added, with no payment the partner carried out
DROP TABLE IF EXISTS "bank"."business_payment_approvals";
DROP TABLE IF EXISTS "bank"."business_payments";
DROP TABLE IF EXISTS "bank"."business_payment_rules";
DROP TABLE IF EXISTS "bank"."business_invites";
DROP TABLE IF EXISTS "bank"."business_advisors";
ALTER TABLE "bank"."business_members" DROP COLUMN IF EXISTS "advisor";
ALTER TABLE "bank"."business_members" DROP COLUMN IF EXISTS "department_id";
ALTER TABLE "bank"."business_members" DROP COLUMN IF EXISTS "custom_role_id";
DROP TABLE IF EXISTS "bank"."business_departments";
DROP TABLE IF EXISTS "bank"."business_custom_roles";
ALTER TABLE "bank"."business_accounts" DROP COLUMN IF EXISTS "owner_user_id";
