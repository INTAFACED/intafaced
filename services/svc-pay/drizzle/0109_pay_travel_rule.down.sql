-- intafaced:destructive — reversal of 0109_pay_travel_rule.sql
--
-- Drops the travel-rule rules, wait limits, transfer records, transitions and encrypted messages. No balance lives in
-- these tables; this is for CI proof of reversibility and a database that recorded no real transfer.

DROP TRIGGER IF EXISTS "travel_rule_messages_append_only_trg" ON "pay"."travel_rule_messages";
DROP TRIGGER IF EXISTS "travel_rule_transitions_append_only_trg" ON "pay"."travel_rule_transitions";
DROP TRIGGER IF EXISTS "travel_rule_transfers_append_only_trg" ON "pay"."travel_rule_transfers";
DROP TRIGGER IF EXISTS "travel_rule_wait_limit_events_append_only_trg" ON "pay"."travel_rule_wait_limit_events";
DROP TRIGGER IF EXISTS "travel_rule_rule_events_append_only_trg" ON "pay"."travel_rule_rule_events";
DROP FUNCTION IF EXISTS "pay"."travel_rule_append_only"();
DROP INDEX IF EXISTS "pay"."travel_rule_messages_transfer_idx";
DROP TABLE IF EXISTS "pay"."travel_rule_messages";
DROP INDEX IF EXISTS "pay"."travel_rule_transitions_transfer_idx";
DROP TABLE IF EXISTS "pay"."travel_rule_transitions";
DROP INDEX IF EXISTS "pay"."travel_rule_transfers_withdrawal_uq";
DROP TABLE IF EXISTS "pay"."travel_rule_transfers";
DROP TABLE IF EXISTS "pay"."travel_rule_wait_limit_events";
DROP INDEX IF EXISTS "pay"."travel_rule_rule_key_idx";
DROP TABLE IF EXISTS "pay"."travel_rule_rule_events";
