-- intafaced:destructive — reversal of 0111_pay_custody_utxo.sql
--
-- Drops the UTXO inventory cache, label history, consolidation triggers, consolidation intents and outcomes. No balance
-- lives in these tables (the chain and the ledger are the books); this is for CI proof of reversibility and a database
-- that recorded no real consolidation.

DROP TRIGGER IF EXISTS "utxo_records_no_delete_trg" ON "pay"."utxo_records";
DROP TRIGGER IF EXISTS "utxo_consolidation_outcomes_append_only_trg" ON "pay"."utxo_consolidation_outcomes";
DROP TRIGGER IF EXISTS "utxo_consolidations_append_only_trg" ON "pay"."utxo_consolidations";
DROP TRIGGER IF EXISTS "utxo_trigger_events_append_only_trg" ON "pay"."utxo_trigger_events";
DROP TRIGGER IF EXISTS "utxo_label_events_append_only_trg" ON "pay"."utxo_label_events";
DROP FUNCTION IF EXISTS "pay"."utxo_records_no_delete"();
DROP FUNCTION IF EXISTS "pay"."custody_utxo_append_only"();
DROP TABLE IF EXISTS "pay"."utxo_consolidation_outcomes";
DROP INDEX IF EXISTS "pay"."utxo_consolidations_ref_uq";
DROP TABLE IF EXISTS "pay"."utxo_consolidations";
DROP INDEX IF EXISTS "pay"."utxo_trigger_network_idx";
DROP TABLE IF EXISTS "pay"."utxo_trigger_events";
DROP TABLE IF EXISTS "pay"."utxo_label_events";
DROP INDEX IF EXISTS "pay"."utxo_records_wallet_state_idx";
DROP TABLE IF EXISTS "pay"."utxo_records";
