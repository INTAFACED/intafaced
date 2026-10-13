-- Restore the 0001 predicate. NOT VALID so this down does not scan a backlog
-- row that still has no reviewer, and does not invent one on the way down.

ALTER TABLE "identity"."kyc_records" DROP CONSTRAINT IF EXISTS "kyc_reviewed_by_ck";
ALTER TABLE "identity"."kyc_records" ADD CONSTRAINT "kyc_reviewed_by_ck"
  CHECK ("status" = 'pending' OR "reviewed_at" IS NOT NULL) NOT VALID;
