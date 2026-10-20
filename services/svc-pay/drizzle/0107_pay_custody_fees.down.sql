-- intafaced:destructive — reversal of 0107_pay_custody_fees.sql
--
-- Drops the recorded fee settings, gas policy and refuel records. No balance lives in these tables; this is for CI proof
-- of reversibility and a database that recorded no real setting.

DROP TRIGGER IF EXISTS "gas_refuels_append_only_trg" ON "pay"."gas_refuels";
DROP TRIGGER IF EXISTS "gas_policy_append_only_trg" ON "pay"."gas_policy_events";
DROP TRIGGER IF EXISTS "network_fee_settings_append_only_trg" ON "pay"."network_fee_settings_events";
DROP FUNCTION IF EXISTS "pay"."custody_fees_append_only"();
DROP INDEX IF EXISTS "pay"."gas_refuels_network_idx";
DROP INDEX IF EXISTS "pay"."gas_refuels_ref_uq";
DROP TABLE IF EXISTS "pay"."gas_refuels";
DROP INDEX IF EXISTS "pay"."gas_policy_network_idx";
DROP TABLE IF EXISTS "pay"."gas_policy_events";
DROP INDEX IF EXISTS "pay"."network_fee_settings_network_idx";
DROP TABLE IF EXISTS "pay"."network_fee_settings_events";
