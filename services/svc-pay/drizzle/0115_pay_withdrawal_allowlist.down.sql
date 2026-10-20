-- intafaced:destructive — reversal of 0115_pay_withdrawal_allowlist.sql
--
-- Drops the allowlist entries, their change requests and decisions, the quorum, mode and one-time-policy history and the
-- event log. No balance lives in these tables; this is for CI proof of reversibility and a database that stored no real list.

DROP TRIGGER IF EXISTS "allowlist_events_append_only_trg" ON "pay"."allowlist_events";
DROP TRIGGER IF EXISTS "allowlist_decisions_append_only_trg" ON "pay"."allowlist_decisions";
DROP TRIGGER IF EXISTS "allowlist_onetime_events_append_only_trg" ON "pay"."allowlist_onetime_policy_events";
DROP TRIGGER IF EXISTS "allowlist_mode_events_append_only_trg" ON "pay"."allowlist_mode_events";
DROP TRIGGER IF EXISTS "allowlist_quorum_events_append_only_trg" ON "pay"."allowlist_quorum_events";
DROP FUNCTION IF EXISTS "pay"."allowlist_append_only"();
DROP INDEX IF EXISTS "pay"."allowlist_events_user_idx";
DROP TABLE IF EXISTS "pay"."allowlist_events";
DROP TABLE IF EXISTS "pay"."allowlist_decisions";
DROP INDEX IF EXISTS "pay"."allowlist_entries_user_idx";
DROP INDEX IF EXISTS "pay"."allowlist_entries_label_uq";
DROP INDEX IF EXISTS "pay"."allowlist_entries_address_uq";
DROP TABLE IF EXISTS "pay"."allowlist_entries";
DROP INDEX IF EXISTS "pay"."allowlist_changes_user_idx";
DROP INDEX IF EXISTS "pay"."allowlist_changes_team_idx";
DROP TABLE IF EXISTS "pay"."allowlist_changes";
DROP INDEX IF EXISTS "pay"."allowlist_onetime_latest_idx";
DROP TABLE IF EXISTS "pay"."allowlist_onetime_policy_events";
DROP INDEX IF EXISTS "pay"."allowlist_mode_latest_idx";
DROP TABLE IF EXISTS "pay"."allowlist_mode_events";
DROP INDEX IF EXISTS "pay"."allowlist_quorum_latest_idx";
DROP TABLE IF EXISTS "pay"."allowlist_quorum_events";
