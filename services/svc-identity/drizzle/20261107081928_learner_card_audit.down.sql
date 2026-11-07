-- intafaced:destructive — reversal of 20261107081928_learner_card_audit.sql
-- The learner_card audit rows stay (an audit is never deleted); the narrow CHECK goes back NOT VALID, for new rows only.
ALTER TABLE "identity"."operator_read_audit" DROP CONSTRAINT IF EXISTS "operator_read_audit_kind_check";
ALTER TABLE "identity"."operator_read_audit" ADD CONSTRAINT "operator_read_audit_kind_check"
  CHECK ("kind" IN ('account_search', 'session_list')) NOT VALID;
