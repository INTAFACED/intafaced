-- Per-action-type approval policy (OPS-change-control-01 CR-1). A governed request carries how many distinct approvers
-- other than the requester it needs and the version of the owner policy row it was proposed under; each approval is one
-- row in action_approval_votes, at most one per person. Rows that are not governed keep both columns null and the fixed
-- one-approver rule. Existing rows are untouched. Reversal: 20261030023842_action_approval_policy_votes.down.sql

ALTER TABLE "identity"."action_approvals" ADD COLUMN IF NOT EXISTS "approvals_required" integer;
ALTER TABLE "identity"."action_approvals" ADD COLUMN IF NOT EXISTS "approvals_given" integer NOT NULL DEFAULT 0;
ALTER TABLE "identity"."action_approvals" ADD COLUMN IF NOT EXISTS "policy_hash" text;

ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_policy_ck";
ALTER TABLE "identity"."action_approvals"
  ADD CONSTRAINT "action_approvals_policy_ck"
  -- Explicit IS NOT NULL: a NULL inside a CHECK passes it, so a half-governed row must not slip through.
  CHECK (
    ("approvals_required" IS NULL AND "policy_hash" IS NULL AND "approvals_given" = 0)
    OR (
      "approvals_required" IS NOT NULL
      AND "policy_hash" IS NOT NULL
      AND "approvals_required" BETWEEN 1 AND 32
      AND "policy_hash" ~ '^sha256:[0-9a-f]{64}$'
      AND "approvals_given" BETWEEN 0 AND "approvals_required"
      AND "kind" = 'four_eyes'
    )
  );

CREATE TABLE IF NOT EXISTS "identity"."action_approval_votes" (
  "approval_id" text NOT NULL REFERENCES "identity"."action_approvals" ("approval_id"),
  "approver_id" text NOT NULL CHECK (char_length("approver_id") BETWEEN 1 AND 128),
  "approved_at" timestamptz NOT NULL,
  PRIMARY KEY ("approval_id", "approver_id")
);

-- One vote per person per request, whatever the case of the id.
CREATE UNIQUE INDEX IF NOT EXISTS "action_approval_votes_person_idx"
  ON "identity"."action_approval_votes" ("approval_id", lower("approver_id"));
