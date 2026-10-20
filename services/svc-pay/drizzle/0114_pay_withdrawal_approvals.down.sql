-- intafaced:destructive — reversal of 0114_pay_withdrawal_approvals.sql
--
-- Drops the approval policy history, the stored requests, their decisions and the event log. No balance lives in these
-- tables (a request moves nothing until it is executed through the ledger recipes); this is for CI proof of reversibility
-- and a database that stored no real request.

DROP TRIGGER IF EXISTS "withdrawal_approval_events_append_only_trg" ON "pay"."withdrawal_approval_events";
DROP TRIGGER IF EXISTS "withdrawal_approval_decisions_append_only_trg" ON "pay"."withdrawal_approval_decisions";
DROP TRIGGER IF EXISTS "withdrawal_approval_policy_events_append_only_trg" ON "pay"."withdrawal_approval_policy_events";
DROP FUNCTION IF EXISTS "pay"."withdrawal_approvals_append_only"();
DROP INDEX IF EXISTS "pay"."withdrawal_approval_events_request_idx";
DROP TABLE IF EXISTS "pay"."withdrawal_approval_events";
DROP TABLE IF EXISTS "pay"."withdrawal_approval_decisions";
DROP INDEX IF EXISTS "pay"."withdrawal_approval_requests_due_idx";
DROP INDEX IF EXISTS "pay"."withdrawal_approval_requests_team_idx";
DROP TABLE IF EXISTS "pay"."withdrawal_approval_requests";
DROP INDEX IF EXISTS "pay"."withdrawal_approval_policy_latest_idx";
DROP TABLE IF EXISTS "pay"."withdrawal_approval_policy_events";
