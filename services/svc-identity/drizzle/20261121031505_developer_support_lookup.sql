-- svc-identity · support's read of one customer's API keys and calls (J-developer-17, DV-errors-02, DV-keys-06)
-- Reversal: 20261121031505_developer_support_lookup.down.sql
--
-- A call's row gains the typed error code its reply carried (`trade.account_restricted`), so a support agent finds the
-- cause by request id without the body. Rows logged before this have none (null). Each support read of a customer's keys
-- or calls is written to `operator_read_audit`, so its kinds gain `developer_keys` and `developer_calls`.

ALTER TABLE "identity"."api_key_calls" ADD COLUMN IF NOT EXISTS "error_code" text
  CHECK ("error_code" IS NULL OR "error_code" ~ '^[A-Za-z][A-Za-z0-9._-]{0,63}$');

ALTER TABLE "identity"."operator_read_audit" DROP CONSTRAINT IF EXISTS "operator_read_audit_kind_check";
ALTER TABLE "identity"."operator_read_audit" ADD CONSTRAINT "operator_read_audit_kind_check"
  CHECK ("kind" IN ('account_search', 'session_list', 'learner_card', 'developer_keys', 'developer_calls'));
