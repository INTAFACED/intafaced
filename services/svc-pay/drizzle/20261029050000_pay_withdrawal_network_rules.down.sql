-- intafaced:destructive — reversal of 20261029050000_pay_withdrawal_network_rules.sql
--
-- Drops the owner's withdrawal rules and their history. For CI proof and a full rollback only: the svc-pay code that reads them
-- must be rolled back first, or every quote and rules read fails on the missing table.
DROP TRIGGER IF EXISTS "withdrawal_network_rule_events_append_only_trg" ON "pay"."withdrawal_network_rule_events";
DROP FUNCTION IF EXISTS "pay"."withdrawal_network_rule_events_append_only"();
DROP TABLE IF EXISTS "pay"."withdrawal_network_rule_events";
DROP TABLE IF EXISTS "pay"."withdrawal_network_rules";
