-- A reviewed change of referrer (CM-referral-01, ENGINE RF-3; J-campaigns-05 #5 and #6). The customer asks; a second
-- person approves through the action-approval service (type referral.rebind). Approval changes the relationship from
-- that time on; stored accruals are not touched. Each row is also the audit record of the request and its decision.
-- Reversal: 0075_referral_rebind_requests.down.sql

CREATE TABLE IF NOT EXISTS "identity"."referral_rebind_requests" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "from_referrer_id" uuid,
  "to_referrer_id" uuid NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 3 AND 500),
  "state" text NOT NULL CHECK ("state" IN ('submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'expired')),
  "approval_id" text,
  "approval_operation_id" text,
  "approval_expires_at" timestamptz,
  "decided_by" uuid,
  "decision_reason" text CHECK ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 3 AND 500),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "applied_at" timestamptz,
  CONSTRAINT "referral_rebind_not_self_ck" CHECK ("user_id" <> "to_referrer_id")
);

-- At most one open request per person.
CREATE UNIQUE INDEX IF NOT EXISTS "referral_rebind_one_open_uq"
  ON "identity"."referral_rebind_requests" ("user_id") WHERE "state" IN ('submitted', 'under_review');
CREATE INDEX IF NOT EXISTS "referral_rebind_user_idx"
  ON "identity"."referral_rebind_requests" ("user_id", "created_at" DESC);
