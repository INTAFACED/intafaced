-- svc-identity · requests for information on a verification case (I-kyc-compliance-03, J-identity-20 #3). A reviewer asks
-- the customer for named items; the case moves to info_requested with one task per item, each due by the owner's deadline
-- (IDENTITY_KYC_RFI_DAYS; unset sets no deadline and the page says so). The history row is published as kycInfoRequested.
-- Reversal: the matching .down.sql
ALTER TABLE "identity"."kyc_cases" DROP CONSTRAINT IF EXISTS "kyc_cases_state_check";
ALTER TABLE "identity"."kyc_cases" ADD CONSTRAINT "kyc_cases_state_check"
  CHECK ("state" IN ('submitted', 'info_requested', 'approved', 'rejected', 'expired'));
ALTER TABLE "identity"."kyc_case_events" DROP CONSTRAINT IF EXISTS "kyc_case_events_state_check";
ALTER TABLE "identity"."kyc_case_events" ADD CONSTRAINT "kyc_case_events_state_check"
  CHECK ("state" IN ('submitted', 'info_requested', 'approved', 'rejected', 'expired'));

CREATE TABLE IF NOT EXISTS "identity"."kyc_case_requests" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "case_id"      uuid NOT NULL REFERENCES "identity"."kyc_cases" ("id") ON DELETE CASCADE,
  -- The case version that asked, so one request is one set of tasks.
  "case_version" integer NOT NULL CHECK ("case_version" >= 1),
  "item_key"     text NOT NULL CHECK ("item_key" ~ '^[a-z][a-z0-9_]{1,63}$'),
  "hint"         text NOT NULL CHECK (char_length("hint") BETWEEN 1 AND 500),
  "state"        text NOT NULL DEFAULT 'requested' CHECK ("state" IN ('requested', 'provided')),
  "due_at"       timestamptz,
  "requested_by" text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kyc_case_requests_item_key" UNIQUE ("case_id", "case_version", "item_key")
);
CREATE INDEX IF NOT EXISTS "kyc_case_requests_case_idx" ON "identity"."kyc_case_requests" ("case_id", "created_at");
