-- intafaced:destructive — reversal of 0113_pay_custody_stuck.sql
--
-- Drops the withdrawal-to-wallet links, stuck thresholds, boost/replace/drop actions and outcomes, and reverse requests,
-- approvals and outcomes. No balance lives in these tables (a posted reverse stays in the ledger); this is for CI proof of
-- reversibility and a database that recorded no real stuck-transaction action.

DROP TRIGGER IF EXISTS "custody_reverse_outcomes_append_only_trg" ON "pay"."custody_reverse_outcomes";
DROP TRIGGER IF EXISTS "custody_reverse_approvals_append_only_trg" ON "pay"."custody_reverse_approvals";
DROP TRIGGER IF EXISTS "custody_reverse_requests_append_only_trg" ON "pay"."custody_reverse_requests";
DROP TRIGGER IF EXISTS "custody_tx_action_outcomes_append_only_trg" ON "pay"."custody_tx_action_outcomes";
DROP TRIGGER IF EXISTS "custody_tx_actions_append_only_trg" ON "pay"."custody_tx_actions";
DROP TRIGGER IF EXISTS "custody_stuck_threshold_append_only_trg" ON "pay"."custody_stuck_threshold_events";
DROP TRIGGER IF EXISTS "custody_tx_wallet_links_append_only_trg" ON "pay"."custody_tx_wallet_links";
DROP FUNCTION IF EXISTS "pay"."custody_stuck_append_only"();
DROP TABLE IF EXISTS "pay"."custody_reverse_outcomes";
DROP TABLE IF EXISTS "pay"."custody_reverse_approvals";
DROP TABLE IF EXISTS "pay"."custody_reverse_requests";
DROP TABLE IF EXISTS "pay"."custody_tx_action_outcomes";
DROP TABLE IF EXISTS "pay"."custody_tx_actions";
DROP TABLE IF EXISTS "pay"."custody_stuck_threshold_events";
DROP TABLE IF EXISTS "pay"."custody_tx_wallet_links";
