-- Reverses requests for information: the tasks go, and a case waiting on information goes back to review.
DROP TABLE IF EXISTS "identity"."kyc_case_requests";
UPDATE "identity"."kyc_cases" SET "state" = 'submitted' WHERE "state" = 'info_requested';
DELETE FROM "identity"."kyc_case_events" WHERE "state" = 'info_requested';
ALTER TABLE "identity"."kyc_case_events" DROP CONSTRAINT IF EXISTS "kyc_case_events_state_check";
ALTER TABLE "identity"."kyc_case_events" ADD CONSTRAINT "kyc_case_events_state_check"
  CHECK ("state" IN ('submitted', 'approved', 'rejected', 'expired'));
ALTER TABLE "identity"."kyc_cases" DROP CONSTRAINT IF EXISTS "kyc_cases_state_check";
ALTER TABLE "identity"."kyc_cases" ADD CONSTRAINT "kyc_cases_state_check"
  CHECK ("state" IN ('submitted', 'approved', 'rejected', 'expired'));
