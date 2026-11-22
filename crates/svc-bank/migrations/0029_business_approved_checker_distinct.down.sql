DROP TRIGGER IF EXISTS "business_approvals_over_threshold_checker_trg" ON "bank"."business_approvals";
DROP FUNCTION IF EXISTS "bank"."business_approvals_over_threshold_checker"();
ALTER TABLE "bank"."business_approvals" DROP CONSTRAINT IF EXISTS "business_approvals_approved_checker_not_maker";
