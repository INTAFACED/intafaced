-- Same-person action approvals (money-out step-up, ADR 2026-10-14-money-out-step-up).
--
-- A four-eyes row needs a second person: approver_id <> requester_id. A money-out
-- step-up row is the requester proving a fresh second factor for their OWN intent,
-- so it is born APPROVED with approver_id = requester_id, bound to the session that
-- proved the factor, and consumed once by the target service.
--
-- `kind` separates the two for good. The old "two distinct people" check stays on
-- every four_eyes row; only a same_person row may name one person twice, and a
-- same_person row must carry the session it is bound to.
--
-- Adds two columns and replaces one CHECK. No row is rewritten: every existing row
-- takes kind = 'four_eyes'.
--
-- Reversal: 0029_action_approval_same_person.down.sql (deletes same_person rows first).

ALTER TABLE "identity"."action_approvals" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'four_eyes';
ALTER TABLE "identity"."action_approvals" ADD COLUMN IF NOT EXISTS "session_id" text;

ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_kind_ck";
ALTER TABLE "identity"."action_approvals"
  ADD CONSTRAINT "action_approvals_kind_ck" CHECK ("kind" IN ('four_eyes', 'same_person'));

ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_distinct_ck";
ALTER TABLE "identity"."action_approvals"
  ADD CONSTRAINT "action_approvals_distinct_ck"
  CHECK ("kind" = 'same_person' OR "approver_id" IS NULL OR "approver_id" <> "requester_id");

ALTER TABLE "identity"."action_approvals" DROP CONSTRAINT IF EXISTS "action_approvals_same_person_ck";
ALTER TABLE "identity"."action_approvals"
  ADD CONSTRAINT "action_approvals_same_person_ck"
  CHECK ("kind" <> 'same_person' OR ("session_id" IS NOT NULL AND "approver_id" = "requester_id"));
