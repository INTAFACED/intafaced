-- Partner applications (CM-referral-05, J-campaigns-07). A person with enough qualified invitees applies; an operator
-- other than the applicant approves or rejects with a reason. A rejection keeps its reason category and the date the
-- person may apply again. Each row is the audit record of the application and its decision. Moves no money.
-- Reversal: 20261112130000_partner_applications.down.sql

CREATE TABLE IF NOT EXISTS "identity"."partner_applications" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "identity"."users"("id") ON DELETE CASCADE,
  "state" text NOT NULL CHECK ("state" IN ('submitted', 'approved', 'rejected')),
  "qualified_count" integer NOT NULL CHECK ("qualified_count" >= 0),
  "required_count" integer NOT NULL CHECK ("required_count" >= 1),
  "decided_by" uuid,
  "decision_reason" text CHECK ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 3 AND 500),
  "reject_category" text CHECK (
    "reject_category" IS NULL OR "reject_category" IN ('not_enough_activity', 'incomplete_application', 'compliance', 'other')
  ),
  "reapply_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  CONSTRAINT "partner_applications_not_self_decided_ck" CHECK ("decided_by" IS NULL OR "decided_by" <> "user_id"),
  CONSTRAINT "partner_applications_rejection_ck" CHECK (
    "state" <> 'rejected' OR ("reject_category" IS NOT NULL AND "reapply_at" IS NOT NULL AND "decision_reason" IS NOT NULL)
  ),
  CONSTRAINT "partner_applications_approval_ck" CHECK ("state" <> 'approved' OR "decision_reason" IS NOT NULL)
);

-- At most one open or approved application per person: two presses file one.
CREATE UNIQUE INDEX IF NOT EXISTS "partner_applications_one_live_uq"
  ON "identity"."partner_applications" ("user_id") WHERE "state" IN ('submitted', 'approved');
CREATE INDEX IF NOT EXISTS "partner_applications_user_idx"
  ON "identity"."partner_applications" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "partner_applications_queue_idx"
  ON "identity"."partner_applications" ("created_at") WHERE "state" = 'submitted';
