-- intafaced:destructive — reversal of 0104_pay_custody_accounts.sql
--
-- Drops the custody entities, vaults, wallets and their history. Vault rows are never deleted in service, so this
-- is for CI proof of reversibility and for a database that never held a real vault. No balance lives here.

DROP TRIGGER IF EXISTS "custody_vaults_no_delete_trg" ON "pay"."custody_vaults";
DROP FUNCTION IF EXISTS "pay"."custody_vaults_no_delete"();
DROP TRIGGER IF EXISTS "custody_events_append_only_trg" ON "pay"."custody_events";
DROP FUNCTION IF EXISTS "pay"."custody_events_append_only"();
DROP INDEX IF EXISTS "pay"."custody_events_subject_idx";
DROP TABLE IF EXISTS "pay"."custody_events";
DROP INDEX IF EXISTS "pay"."custody_wallets_address_uq";
DROP TABLE IF EXISTS "pay"."custody_wallets";
DROP INDEX IF EXISTS "pay"."custody_vaults_entity_idx";
DROP INDEX IF EXISTS "pay"."custody_vaults_entity_name_uq";
DROP TABLE IF EXISTS "pay"."custody_vaults";
DROP INDEX IF EXISTS "pay"."custody_entities_customer_env_uq";
DROP TABLE IF EXISTS "pay"."custody_entities";
