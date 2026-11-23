-- intafaced:destructive — reversal of 20261121031505_developer_support_lookup.sql
-- The calls' error codes are dropped with their column; the support read audit rows stay (an audit is never deleted), so
-- the narrow CHECK goes back NOT VALID, for new rows only.
ALTER TABLE "identity"."api_key_calls" DROP COLUMN IF EXISTS "error_code";
ALTER TABLE "identity"."operator_read_audit" DROP CONSTRAINT IF EXISTS "operator_read_audit_kind_check";
ALTER TABLE "identity"."operator_read_audit" ADD CONSTRAINT "operator_read_audit_kind_check"
  CHECK ("kind" IN ('account_search', 'session_list', 'learner_card')) NOT VALID;
