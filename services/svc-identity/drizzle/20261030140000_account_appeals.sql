-- Appeals against a restriction staff set (I-account-lifecycle-12, J-identity-14 #3 and #4). One open appeal
-- ('submitted' or 'in_review') per restriction at a time, held by the partial unique index. A decision moves the row by
-- compare-and-set on `version` and appends to `account_appeal_events`, so the history keeps every step.
-- `restriction_ref` names the restriction as it stood when the appeal was filed (its kind and version), and
-- `restricted_by` and `restriction_approved_by` the staff who set and approved it, so the decision can refuse both.
-- Reversal: 20261030140000_account_appeals.down.sql

CREATE TABLE IF NOT EXISTS "identity"."account_appeals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "identity"."users" ("id") ON DELETE CASCADE,
  "restriction" text NOT NULL,
  "restriction_ref" text NOT NULL,
  "restricted_by" uuid,
  "restriction_approved_by" uuid,
  "client_request_id" text NOT NULL,
  "text" text NOT NULL,
  "status" text NOT NULL DEFAULT 'submitted',
  "decision_reason_code" text,
  "decided_by" uuid,
  "decided_at" timestamptz,
  "version" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "account_appeals_restriction_ck" CHECK ("restriction" IN ('trading_restricted')),
  CONSTRAINT "account_appeals_status_ck" CHECK ("status" IN ('submitted', 'in_review', 'upheld', 'lifted', 'withdrawn')),
  CONSTRAINT "account_appeals_decided_ck" CHECK (
    ("status" IN ('upheld', 'lifted')) = ("decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND "decision_reason_code" IS NOT NULL)
  ),
  CONSTRAINT "account_appeals_reason_code_ck" CHECK ("decision_reason_code" IS NULL OR "decision_reason_code" ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT "account_appeals_text_ck" CHECK (char_length("text") BETWEEN 1 AND 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_appeals_request_uq" ON "identity"."account_appeals" ("user_id", "client_request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "account_appeals_one_open_uq" ON "identity"."account_appeals" ("user_id", "restriction_ref")
  WHERE "status" IN ('submitted', 'in_review');
CREATE INDEX IF NOT EXISTS "account_appeals_open_idx" ON "identity"."account_appeals" ("created_at")
  WHERE "status" IN ('submitted', 'in_review');

CREATE TABLE IF NOT EXISTS "identity"."account_appeal_events" (
  "id" bigserial PRIMARY KEY,
  "appeal_id" uuid NOT NULL REFERENCES "identity"."account_appeals" ("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "actor_id" uuid,
  "reason_code" text,
  "at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "account_appeal_events_appeal_idx" ON "identity"."account_appeal_events" ("appeal_id", "id");

-- The notice a decision sends ("your appeal was decided"): the outcome only, the words are on the status page.
ALTER TABLE "identity"."mail_outbox" DROP CONSTRAINT IF EXISTS "mail_outbox_purpose_check";
ALTER TABLE "identity"."mail_outbox"
  ADD CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" IN (
    'password-reset', 'reset-no-account', 'handle-recovery', 'handle-recovery-no-account', 'signup-code', 'signup-existing',
    'login-code', 'login-no-account', 'new-device-code', 'withdraw-address-approval', 'password-changed',
    'mfa-reset-code', 'mfa-reset-started', 'mfa-reset-cancelled', 'mfa-reset-completed', 'factor-changed',
    'support-recovery', 'support-recovery-used', 'appeal-decided'
  ));
