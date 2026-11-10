-- svc-identity · the learner card lookup is audited like the account search (J-academy-14 #1)
-- Reversal: 20261107081928_learner_card_audit.down.sql
--
-- `learnerCard.lookup` finds one account by its exact email, handle or id for a support desk and records the lookup as
-- a hash of the term in `operator_read_audit`, so the audit's kinds gain `learner_card`.

ALTER TABLE "identity"."operator_read_audit" DROP CONSTRAINT IF EXISTS "operator_read_audit_kind_check";
ALTER TABLE "identity"."operator_read_audit" ADD CONSTRAINT "operator_read_audit_kind_check"
  CHECK ("kind" IN ('account_search', 'session_list', 'learner_card'));
